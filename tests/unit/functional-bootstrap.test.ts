import { describe,it,expect } from 'vitest';
import { readFileSync } from 'node:fs';
const template=readFileSync('.env.example','utf8');
const {validateBootstrapConfig}=await import(new URL('../../scripts/validate-bootstrap-config.mjs',import.meta.url).href);
function check(changes:Record<string,string>={}){
  const lines=Object.fromEntries(template.split('\n').filter(l=>/^[A-Z][A-Z0-9_]*=/.test(l)).map(l=>[l.slice(0,l.indexOf('=')),l.slice(l.indexOf('=')+1)]));
  return {status:'PASS',...validateBootstrapConfig({...lines,...changes})};
}
describe('deployment preflight without configuration rewrites',()=>{
  it('accepts the original default template and reports binding absence',()=>{expect(check()).toMatchObject({status:'PASS',mode:'storage',bindingStatus:'NOT_CONFIGURED'});});
  it('rejects scope divergence and incomplete service identities',()=>{
    expect(()=>check({UGV_DATA_SCOPE_KEY:'retained-site'})).toThrow();
    for(const changes of [{SMPP_SERVICE_KEY:'service'},{SDAR_MCP_SERVER_ID:'server'},{SDAR_AGENT_PROFILE_ID:'profile'}])expect(()=>check(changes)).toThrow();
  });
  it('preserves a matching explicit scope and requires both consumers in ready mode',()=>{
    expect(check({UGV_DATA_SCOPE_KEY:'retained-site',GATEWAY_DATA_SCOPE_CLAIM:'retained-site'}).status).toBe('PASS');
    expect(()=>check({GOWM_BUSINESS_INSTALL_MODE:'ready'})).toThrow();
    expect(check({GOWM_BUSINESS_INSTALL_MODE:'ready',SMPP_SERVICE_KEY:'s',UGV_PROVIDER_ID:'p',UGV_RESOURCE_ID:'r',SDAR_SERVICE_KEY:'a',SDAR_MCP_SERVER_ID:'m'}).bindingStatus).toBe('CONFIGURED');
  });
});
