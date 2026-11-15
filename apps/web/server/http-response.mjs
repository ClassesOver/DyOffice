import { STATUS_CODES } from 'node:http';

// Keep legacy JSON/error fields while adding the common Problem migration envelope.
export function sendJson(res, status, value) {
  const payload=status>=400?{...value,type:'about:blank',title:STATUS_CODES[status]||'Error',status,detail:value.error,requestId:res.getHeader('X-Request-ID')}:value;
  res.writeHead(status,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'});
  res.end(JSON.stringify(payload));
}
