let onUnauthorized=()=>{}; export const setUnauthorizedHandler=(fn)=>{onUnauthorized=fn};

// A request that never settles must not be able to freeze the UI: callers that
// care (the bootstrap/session check, the first data load) pass `timeoutMs`.
function netError(message,extra){const e=new Error(message);e.network=true;Object.assign(e,extra||{});return e;}

export function isTransientError(err){
  if(!err) return false;
  if(err.network||err.timedOut) return true;
  if(err instanceof TypeError) return true;
  if(typeof navigator!=='undefined'&&navigator.onLine===false) return true;
  const s=err.status;
  return typeof s==='number'&&(s===0||s===408||s===425||s===429||(s>=500&&s<=599));
}

export async function api(url,opts={}){
  const {timeoutMs,...rest}=opts;
  const token=localStorage.getItem('clearpath_token');
  const headers={'Content-Type':'application/json',...(rest.headers||{})};
  if(token)headers.Authorization=`Bearer ${token}`;
  let r;
  if(timeoutMs){
    const ctl=new AbortController();
    const timer=setTimeout(()=>ctl.abort(),timeoutMs);
    try{r=await fetch(url,{...rest,headers,signal:ctl.signal});}
    catch(err){
      if(err&&err.name==='AbortError')throw netError('The workspace did not respond in time.',{timedOut:true});
      throw netError('Could not reach the workspace.');
    }
    finally{clearTimeout(timer);}
  }else{
    try{r=await fetch(url,{...rest,headers});}
    catch(err){throw netError('Could not reach the workspace.');}
  }
  if(r.status===401&&url!=='/api/auth/login'){onUnauthorized();}
  if(!r.ok){const e=await r.json().catch(()=>({}));const err=new Error(e.error||'Request failed');err.status=r.status;Object.assign(err,e);throw err;}
  return r.status===204?null:r.json();
}
