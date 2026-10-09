#!/usr/bin/env python3
"""Run the real fail-closed boundary verifier against isolated generated candidate fixtures."""
import json,os,pathlib,subprocess,sys,tempfile,unittest
ROOT=pathlib.Path(__file__).resolve().parents[1]
SCRIPT=ROOT/"scripts/deploy/verify-financial-boundary.py"
HASH="a"*16
def run(env_mode=False, valid_hash=True, webhook=True, wrong_flag=False):
    with tempfile.TemporaryDirectory(prefix="zpc-boundary-") as work:
        vars={"SALE_GLOBALLY_ENABLED":"false","CERTIFICATION_PILOT_PRODUCTION_ALLOWED":"false",
              "WHATSAPP_SALES_ENABLED":"false","ASAAS_ENV":"sandbox","CERTIFICATION_PILOT_ENV":"sandbox",
              "PAYMENT_PROVIDER":"mercadopago","MERCADOPAGO_ENV":"production" if env_mode else "sandbox",
              "ABSOLUTE_RELEASE_APPROVED":"true" if env_mode else "false",
              "PRE_SALE_GATES_APPROVED":"true" if env_mode else "false",
              "ZEVANORY_RUNTIME_CONFIG":{"MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16":HASH} if env_mode else {}}
        if wrong_flag:vars["SALE_GLOBALLY_ENABLED"]="true"
        pathlib.Path(work,"wrangler.central-fix.jsonc").write_text(json.dumps({"vars":vars}))
        e={**os.environ,"ZEVANORY_LAUNCH_AUTHORIZATION":"AUTORIZO COMPRA REAL" if env_mode else "",
           "MERCADOPAGO_PRODUCTION_ACCOUNT_HASH16":HASH if valid_hash else "",
           "MERCADOPAGO_PRODUCTION_WEBHOOK_VERIFIED":"true" if webhook else ""}
        out=subprocess.run([sys.executable,str(SCRIPT)],cwd=work,env=e,stdout=subprocess.PIPE,stderr=subprocess.STDOUT,text=True,timeout=10)
        return out.returncode,out.stdout
class Tests(unittest.TestCase):
    def test_closed_default_pass(self):self.assertEqual(run()[0],0)
    def test_authorized_production_hash_and_webhook_pass(self):self.assertEqual(run(env_mode=True)[0],0)
    def test_authorized_hash_missing_blocks(self):self.assertIn("LAUNCH_COLLECTOR_PROOF_MISSING",run(env_mode=True,valid_hash=False)[1])
    def test_authorized_webhook_missing_blocks(self):self.assertIn("LAUNCH_PRODUCTION_WEBHOOK_UNVERIFIED",run(env_mode=True,webhook=False)[1])
    def test_sales_enabled_never_allowed(self):self.assertIn("DEPLOY_MUST_KEEP_SALES_CLOSED",run(env_mode=True,wrong_flag=True)[1])
if __name__=="__main__":unittest.main(verbosity=2)
