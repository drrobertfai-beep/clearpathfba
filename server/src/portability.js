import db from './db.js';
import { dataPointVocab, LABELS } from './vocab.js';
import { deidentify } from './deidentify.js';

const label=(kind,v)=>LABELS[kind]?.[v]||v||'';
export async function assessmentExport(id) {
 const a=await db.prepare('SELECT * FROM assessments WHERE id=? AND deleted_at IS NULL').get(id); if(!a)return null;
 const client=await db.prepare('SELECT * FROM clients WHERE id=? AND deleted_at IS NULL').get(a.client_id);
 const behaviors=await db.prepare('SELECT * FROM target_behaviors WHERE assessment_id=? ORDER BY id').all(id);
 const points=await db.prepare('SELECT * FROM data_points WHERE assessment_id=? ORDER BY recorded_at,id').all(id);
 const hypotheses=(await db.prepare('SELECT * FROM function_hypotheses WHERE assessment_id=? ORDER BY target_behavior_id').all(id)).map(h=>{let evidence={};try{evidence=JSON.parse(h.evidence||'{}')}catch{}return {...h,evidence};});
 const sign_offs=await db.prepare('SELECT * FROM sign_offs WHERE assessment_id=? ORDER BY id').all(id);
 return {exported_at:new Date().toISOString(),app:'ClearPathFBA',client,assessment:a,behaviors,data_points:points,function_hypotheses:hypotheses,sign_offs};
}
export async function csvExport(id) {
 const p=await assessmentExport(id); if(!p)return null;
 const names=Object.fromEntries(p.behaviors.map(b=>[b.id,b.name]));
 const cols=['recorded_at','target_behavior','measurement_type','value','setting','antecedent','consequence','notes'];
 const esc=v=>{const s=String(v??'');return /[",\n\r]/.test(s)?`"${s.replaceAll('"','""')}"`:s};
 const rows=p.data_points.map(x=>[x.recorded_at,names[x.target_behavior_id]||x.target_behavior_id,label('measurementTypes',x.measurement_type),x.value,label('settings',x.setting),label('antecedents',x.antecedent),label('consequences',x.consequence),x.notes].map(esc).join(','));
 return {payload:p,csv:[cols.join(','),...rows].join('\r\n')+'\r\n'};
}
const normalize=(v)=>String(v??'').trim().toLowerCase();
function csvRows(text){const lines=[];let row=[],cell='',quoted=false;for(let i=0;i<text.length;i++){const c=text[i];if(quoted){if(c==='"'&&text[i+1]==='"'){cell+='"';i++;}else if(c==='"')quoted=false;else cell+=c;}else if(c==='"')quoted=true;else if(c===','){row.push(cell);cell='';}else if(c==='\n'){row.push(cell);lines.push(row);row=[];cell='';}else if(c!=='\r')cell+=c;}if(cell||row.length){row.push(cell);lines.push(row);}return lines;}
function vocabValue(kind,value){if(!value)return null;const vals=dataPointVocab[kind];const n=normalize(value);return vals.find(x=>normalize(x)===n)||vals.find(x=>normalize(label(kind,x))===n)||null;}
export async function importCsv(id,text) {
 const a=await db.prepare('SELECT id FROM assessments WHERE id=? AND deleted_at IS NULL').get(id);if(!a)return {notFound:true};
 const lines=csvRows(String(text||''));if(!lines.length)return {error:'CSV is empty.'};
 const headers=lines[0].map(normalize);const required=['recorded_at','target_behavior','measurement_type','value'];const missing=required.filter(x=>!headers.includes(x));if(missing.length)return {error:`Missing required columns: ${missing.join(', ')}.`};
 const idx=Object.fromEntries(headers.map((h,i)=>[h,i]));const behaviors=await db.prepare('SELECT id,name FROM target_behaviors WHERE assessment_id=?').all(id);const byName=new Map(behaviors.map(b=>[normalize(b.name),b]));
 const rejected=[],valid=[];for(let i=1;i<lines.length;i++){const r=lines[i];if(r.every(x=>!String(x).trim()))continue;const rowNo=i+1;const get=k=>r[idx[k]]??'';let reason=null;const date=String(get('recorded_at')).trim();if(!date||Number.isNaN(Date.parse(date.replace(' ','T'))))reason='recorded_at must be a parseable ISO-8601 or YYYY-MM-DD HH:MM date';
 let behavior=null;if(!reason){const raw=String(get('target_behavior')).trim();behavior=/^\d+$/.test(raw)?behaviors.find(b=>b.id===Number(raw)):byName.get(normalize(raw));if(!behavior)reason='unknown target behavior';}
 const mt=normalize(get('measurement_type'));if(!reason&&!dataPointVocab.measurementTypes.includes(mt))reason='measurement_type must be frequency, duration, or latency';
 const value=Number(get('value'));if(!reason&&(!Number.isFinite(value)||value<0))reason='value must be a non-negative number';
 const mapped={};for(const [field,kind] of [['setting','settings'],['antecedent','antecedents'],['consequence','consequences']]){if(!reason&&get(field).trim()){mapped[field]=vocabValue(kind,get(field));if(!mapped[field])reason=`invalid ${field}`;}}
 if(reason)rejected.push({row:rowNo,reason});else valid.push({assessment_id:id,target_behavior_id:behavior.id,recorded_at:date.replace(' ','T'),setting:mapped.setting||null,antecedent:mapped.antecedent||null,behavior:null,consequence:mapped.consequence||null,measurement_type:mt,value,notes:String(get('notes')).trim()||null});}
 return {valid,rejected};
}
export {deidentify};
