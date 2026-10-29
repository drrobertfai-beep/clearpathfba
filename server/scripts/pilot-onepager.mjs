#!/usr/bin/env node
/**
 * ClearPathFBA — render the pilot onboarding guide to a print-ready one-pager.
 *
 * Source of truth is docs/pilot-onboarding.md: this script parses the small
 * subset of Markdown that file uses (h1, paragraphs, numbered/bulleted lists,
 * **bold** runs) and lays it out on exactly ONE US Letter page with pdfkit.
 * It refuses to write a PDF that spills onto a second page, so the "one page"
 * promise is enforced at build time rather than eyeballed.
 *
 * Usage (from the repository root):
 *   npm run pilot:onepager
 */
import fs from 'node:fs';
import path from 'node:path';
import PDFDocument from 'pdfkit';

const SRC = process.env.ONEPAGER_SRC || path.resolve('docs', 'pilot-onboarding.md');
const OUT = process.env.ONEPAGER_OUT || path.resolve('docs', 'pilot-onboarding.pdf');
const FOOTER = 'ClearPathFBA · app.clearpathfba.com · pilot onboarding';

const PAGE = { size: 'LETTER', margin: 40 }; // 612 x 792 pt; 8.5 x 11 in
const COLORS = { ink: '#1f2933', muted: '#5b6770', rule: '#c8d0d6', accent: '#197d6b' };
const BODY = 9.2;   // body font size (pt)
const LEAD = 1.42;   // pdfkit lineGap multiplier for body text
const GAP = 4.5;    // vertical gap between blocks (pt)

/** Parse the guide into blocks: {type:'h1'|'h2'|'p'|'li', marker, text}. */
function parse(markdown) {
  const blocks = [];
  for (const rawLine of markdown.split(/\r?\n/)) {
    const line = rawLine.trimEnd();
    if (!line.trim()) continue;
    if (line.startsWith('# ')) { blocks.push({ type: 'h1', text: line.slice(2).trim() }); continue; }
    if (line.startsWith('## ')) { blocks.push({ type: 'h2', text: line.slice(3).trim() }); continue; }
    const numbered = line.match(/^(\d+)\.\s+(.*)$/);
    if (numbered) { blocks.push({ type: 'li', marker: `${numbered[1]}.`, text: numbered[2] }); continue; }
    const bullet = line.match(/^[-*]\s+(.*)$/);
    if (bullet) { blocks.push({ type: 'li', marker: '•', text: bullet[1] }); continue; }
    blocks.push({ type: 'p', text: line });
  }
  return blocks;
}

/** Split a string on **bold** markers into runs: [{text, bold}]. */
function runs(text) {
  const out = [];
  const parts = String(text).split('**');
  parts.forEach((part, i) => { if (part) out.push({ text: part, bold: i % 2 === 1 }); });
  return out;
}

/** Write one paragraph of mixed bold/regular runs at the current position. */
function writeRuns(doc, text, { size = BODY, color = COLORS.ink, x, width } = {}) {
  const pieces = runs(text);
  pieces.forEach((piece, i) => {
    doc.font(piece.bold ? 'Helvetica-Bold' : 'Helvetica').fontSize(size).fillColor(color);
    doc.text(piece.text, x ?? doc.x, undefined, {
      width: width ?? doc.page.width - doc.page.margins.left - doc.page.margins.right,
      continued: i < pieces.length - 1,
      lineGap: size * LEAD - size,
    });
  });
}

function build(blocks) {
  const doc = new PDFDocument({
    size: PAGE.size,
    margins: { top: 34, bottom: 36, left: 46, right: 46 },
    bufferPages: true,
    info: {
      Title: 'ClearPathFBA — Pilot Clinician Onboarding',
      Author: 'ClearPathFBA',
      Subject: 'One-page onboarding guide for pilot clinicians',
    },
  });
  const chunks = [];
  // Count pages as they are added: bufferedPageRange() is empty once the
  // document has been flushed, so the "one page" check needs this counter.
  let pageCount = 1;
  doc.on('pageAdded', () => { pageCount += 1; });
  doc.on('data', (c) => chunks.push(c));
  const done = new Promise((resolve, reject) => { doc.on('end', () => resolve(Buffer.concat(chunks))); doc.on('error', reject); });

  const left = doc.page.margins.left;
  const contentWidth = doc.page.width - doc.page.margins.left - doc.page.margins.right;

  for (const block of blocks) {
    if (block.type === 'h1') {
      doc.font('Helvetica-Bold').fontSize(14.5).fillColor(COLORS.accent)
        .text(block.text, left, doc.y, { width: contentWidth });
      doc.moveDown(0.25);
      doc.moveTo(left, doc.y).lineTo(left + contentWidth, doc.y).lineWidth(1).strokeColor(COLORS.rule).stroke();
      doc.moveDown(0.5);
    } else if (block.type === 'h2') {
      doc.moveDown(0.35);
      doc.font('Helvetica-Bold').fontSize(BODY + 0.8).fillColor(COLORS.accent)
        .text(block.text, left, doc.y, { width: contentWidth });
      doc.moveDown(0.15);
    } else if (block.type === 'li') {
      // The marker is part of the item's single text flow: a wrapped item then
      // stays compact and the whole guide fits on one page.
      writeRuns(doc, `${block.marker} ${block.text}`, { x: left, width: contentWidth });
      doc.moveDown(0.12);
    } else {
      writeRuns(doc, block.text, { x: left, width: contentWidth });
      doc.moveDown(GAP / BODY);
    }
  }

  // No footer: anything drawn below the bottom margin would push pdfkit
  // onto a second page, and the guide must stay a single sheet.
  doc.end();
  return { done, pages: () => pageCount };
}

async function main() {
  if (!fs.existsSync(SRC)) throw new Error(`Source markdown not found: ${SRC}`);
  const blocks = parse(fs.readFileSync(SRC, 'utf8'));
  const { done, pages: pageCount } = build(blocks);
  const buf = await done;
  const pages = pageCount();
  if (pages !== 1) throw new Error(`Layout spilled onto ${pages} pages — trim docs/pilot-onboarding.md or tighten the type.`);
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, buf);
  const words = blocks.reduce((n, b) => n + b.text.replace(/\*\*/g, '').split(/\s+/).filter(Boolean).length, 0);
  console.log(`Wrote ${path.relative(process.cwd(), OUT)} — 1 page, ${buf.length} bytes, ${words} words (source: ${path.relative(process.cwd(), SRC)})`);
}

main().catch((err) => { console.error('Onepager build failed:', err.message); process.exit(1); });
