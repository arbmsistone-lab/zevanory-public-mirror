import os,json,pathlib,urllib.request,urllib.error
raw=os.environ.get('MERCADOPAGO_TEST_BUYER_EMAIL','');value=raw.strip();token=os.environ.get('MERCADOPAGO_TEST_ACCESS_TOKEN','').strip()
report={'operation':'read_only_test_buyer_diagnostic','source_sha':os.environ['GITHUB_SHA'],'new_payments':0,'new_synthesis_requests':0,'sale_unlock':False,'configured_buyer':{'present':bool(value),'outer_whitespace':raw!=value,'wrapped_in_quotes':len(value)>1 and value[0] in '\"\'' and value[-1]==value[0],'contains_at':'@' in value,'test_email_suffix_exact':value.endswith('@testuser.com'),'test_email_suffix_casefold':value.lower().endswith('@testuser.com'),'numeric_id':value.isdigit(),'test_username_prefix':value.lower().startswith(('testuser','test_user_'))}}
def get(path):
 try:
  with urllib.request.urlopen(urllib.request.Request('https://api.mercadopago.com'+path,headers={'authorization':'Bearer '+token,'accept':'application/json'}),timeout=30) as r:return json.loads(r.read())
 except urllib.error.HTTPError as e:raise RuntimeError('mercadopago_http_'+str(e.code)) from None
try:
 seller=get('/users/me');report['seller_id']=seller.get('id');report['seller_is_test']='test_user' in seller.get('tags',[])
 report['configured_buyer']['equals_seller_email']=value.lower()==str(seller.get('email','')).lower()
 report['configured_buyer']['equals_seller_id']=value==str(seller.get('id',''))
 report['productive_creation_credential_present']=bool(os.environ.get('MERCADOPAGO_ACCESS_TOKEN','').strip())
 if value.isdigit():
  buyer=get('/users/'+value);report['buyer_id']=buyer.get('id');report['buyer_is_test']='test_user' in buyer.get('tags',[]);report['buyer_distinct']=buyer.get('id')!=seller.get('id')
 report['diagnostic']='complete'
except Exception as e:report['cause']=str(e);print('::error title=BUYER_DIAGNOSTIC::'+str(e))
pathlib.Path('/tmp/buyer-diagnostic').mkdir(exist_ok=True);pathlib.Path('/tmp/buyer-diagnostic/report.json').write_text(json.dumps(report,indent=2));print(json.dumps(report))
