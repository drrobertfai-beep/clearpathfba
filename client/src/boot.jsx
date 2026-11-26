import React,{useEffect,useRef,useState} from 'react';
import {api,isTransientError} from './api.js';

// Backoff used both for the session check and the first data load. Total wait
// before the last step is ~45s, which covers a 20-30s cold start (a suspended
// database compute waking up) without hammering the server.
export const RETRY_DELAYS=[700,1200,2000,3000,4500,6000,8000,10000,12000,15000];
export const SLOW_HINT_MS=7000;     // "waking up" note appears
export const STALL_AFTER_MS=35000;  // honest "can't reach it" message + manual retry
export const REQUEST_TIMEOUT_MS=20000;

export const retryDelay=i=>RETRY_DELAYS[Math.min(Math.max(i,0),RETRY_DELAYS.length-1)];
export const sleep=ms=>new Promise(r=>setTimeout(r,ms));

function useOnline(){
  const [online,setOnline]=useState(()=>typeof navigator==='undefined'?true:navigator.onLine!==false);
  useEffect(()=>{
    const on=()=>setOnline(true),off=()=>setOnline(false);
    window.addEventListener('online',on);window.addEventListener('offline',off);
    return ()=>{window.removeEventListener('online',on);window.removeEventListener('offline',off)};
  },[]);
  return online;
}

/**
 * Session bootstrap: GET /api/auth/me with backoff.
 *
 * The important property: a slow or unreachable backend is NEVER treated as
 * "you are signed out". Only a real 401/403 clears the session; everything
 * transient keeps retrying and shows the connecting state instead.
 */
export function useWorkspaceBoot({enabled,onUser,onSignedOut,onFailed}){
  const [phase,setPhase]=useState(enabled?'connecting':'ready'); // connecting | stalled | ready
  const [attempt,setAttempt]=useState(0);
  const [elapsed,setElapsed]=useState(0);
  const [waitMs,setWaitMs]=useState(0);
  const [tick,setTick]=useState(0);
  const handlers=useRef({});handlers.current={onUser,onSignedOut,onFailed};
  const started=useRef(Date.now());
  const online=useOnline();

  useEffect(()=>{
    if(!enabled)return;
    let cancelled=false;
    started.current=Date.now();
    setPhase('connecting');setAttempt(0);setElapsed(0);setWaitMs(0);
    (async()=>{
      for(let i=0;;i++){
        if(cancelled)return;
        setAttempt(i+1);
        try{
          const u=await api('/api/auth/me',{timeoutMs:REQUEST_TIMEOUT_MS});
          if(cancelled)return;
          setPhase('ready');
          handlers.current.onUser&&handlers.current.onUser(u);
          return;
        }catch(e){
          if(cancelled)return;
          if(e.status===401||e.status===403){
            setPhase('ready');
            handlers.current.onSignedOut&&handlers.current.onSignedOut();
            return;
          }
          if(!isTransientError(e)){
            setPhase('ready');
            handlers.current.onFailed&&handlers.current.onFailed(e);
            return;
          }
          const d=retryDelay(i);
          setWaitMs(d);
          await sleep(d);
        }
      }
    })();
    const timer=setInterval(()=>{
      if(cancelled)return;
      const ms=Date.now()-started.current;
      setElapsed(ms);
      if(ms>=STALL_AFTER_MS)setPhase(p=>p==='connecting'?'stalled':p);
    },500);
    return ()=>{cancelled=true;clearInterval(timer)};
  },[enabled,tick]);

  return {
    phase,attempt,elapsed,waitMs,online,
    retryNow:()=>{started.current=Date.now();setTick(t=>t+1)},
  };
}

function Brand(){
  return <div className="boot-brand"><span className="mark">C</span><strong>ClearPath<span>FBA</span></strong></div>;
}

/** Full-screen state shown while the app cannot talk to its backend yet. */
export function ConnectingScreen({attempt,elapsedMs,phase,waitMs,online,onRetry,onOpenOffline}){
  const stalled=phase==='stalled';
  const slow=elapsedMs>=SLOW_HINT_MS;
  return <main className="boot-screen" role="status" aria-live="polite">
    <div className="boot-card">
      <Brand/>
      {stalled?<span className="boot-warn" aria-hidden="true">!</span>:<span className="boot-spinner" aria-hidden="true"/>}
      <h1>{stalled?'We can’t reach your workspace yet':'Connecting to your workspace…'}</h1>
      {stalled?<p className="muted">
        The server has not answered. Nothing has been lost and you are still signed in — this is usually the workspace waking up after a quiet period, which can take up to 30 seconds.
      </p>:<p className="muted">
        {slow
          ?'Your workspace is waking up. This can take up to 30 seconds after a period of inactivity — please keep this tab open.'
          :'Loading your clients and assessments.'}
      </p>}
      <p className="boot-status">
        {online?'':'You appear to be offline. '}
        Attempt {Math.max(attempt,1)}
        {stalled?'. Still retrying in the background.':waitMs?` · retrying in ${Math.round(waitMs/1000)||1}s…`:' · waiting for the server…'}
      </p>
      <div className="boot-actions">
        <button className="primary" onClick={onRetry}>{stalled?'Try again now':'Retry now'}</button>
        {onOpenOffline&&<button onClick={onOpenOffline}>Open offline copy</button>}
      </div>
      {stalled&&<p className="boot-hint">
        If this keeps happening, check your internet connection and reload the page. Your session stays signed in on this device.
      </p>}
    </div>
  </main>;
}

/** In-app banner/panel for a data load that is retrying or gave up. */
export function ConnectingNotice({title,detail,attempt,waitMs,onRetry,compact}){
  return <div className={'boot-notice'+(compact?' compact':'')} role="status" aria-live="polite">
    <span className="boot-spinner small" aria-hidden="true"/>
    <div>
      <b>{title||'Connecting to your workspace…'}</b>
      <p className="muted">{detail||'The server has not answered yet — this is usually the workspace waking up. Retrying automatically.'}</p>
      {attempt?<p className="boot-status">Attempt {attempt}{waitMs?` · retrying in ${Math.round(waitMs/1000)||1}s…`:''}</p>:null}
    </div>
    {onRetry&&<button className="small" onClick={onRetry}>Retry now</button>}
  </div>;
}
