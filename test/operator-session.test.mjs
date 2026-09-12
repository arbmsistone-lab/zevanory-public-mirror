import test from 'node:test';
import assert from 'node:assert/strict';
import {createOperatorSessionCookie,hasValidOperatorSession} from '../src/operatorSession.mjs';
const env={OPERATOR_TOKEN_SECONDARY:'secondary-secret-for-tests'};
test('operator bearer can mint a secure HttpOnly session cookie',()=>{
  const cookie=createOperatorSessionCookie(env,1_800_000_000_000);
  assert.match(cookie,/^zv_op_session=\d{10}\.[0-9a-f]{64};/);
  for(const flag of ['HttpOnly','Secure','SameSite=Strict','Path=/api/robot-control'])assert.ok(cookie.includes(flag));
});
test('valid operator session authenticates and tampering fails closed',()=>{
  const now=1_800_000_000_000;const cookie=createOperatorSessionCookie(env,now);
  const value=cookie.split(';')[0];
  assert.equal(hasValidOperatorSession({headers:{cookie:value}},env,now+1000),true);
  assert.equal(hasValidOperatorSession({headers:{cookie:value+'x'}},env,now+1000),false);
});
test('expired operator session fails closed',()=>{
  const now=1_800_000_000_000;const value=createOperatorSessionCookie(env,now).split(';')[0];
  assert.equal(hasValidOperatorSession({headers:{cookie:value}},env,now+13*60*60*1000),false);
});