// NC-015 N2: read-only static release-file exposure census.
// It proves only the checked-out public repository surface, NOT Hotmart Club,
// Cloudflare currently deployed versions or externally hosted assets.
import {existsSync,readdirSync,readFileSync} from "node:fs";
import {resolve,relative,join} from "node:path";
import {fileURLToPath} from "node:url";
const ROOT=fileURLToPath(new URL("../..",import.meta.url));
const PUBLIC_DIRS=["sales-public","sales-overlay","public","assets","pages-mirror"];
const EXT=/\.(?:pdf|zip|docx?|xlsx?|rar|7z)(?:[?#][^\s"'<>]*)?$/i;
const STATIC_EXT=/\.(?:html?|js|mjs|css|json|txt|xml|md)$/i;
const URL_RE=/(?:https?:\/\/[^\s"'<>\\]+|\/[a-z0-9_/%.-]+)\.(?:pdf|zip|docx?|xlsx?|rar|7z)(?:\?[^\s"'<>]*)?/gi;
const HREF_RE=/(?:href|src|data-url|url|download|file)\s*[:=]\s*["']([^"']+)["']/gi;
const LINK_RE=/\b(?:download|baixar|arquivo)\b[\s\S]{0,150}(?:href|src)=["'][^"']+["']/gi;
function walk(start){
 const out=[];
 if(!existsSync(start))return out;
 for(const e of readdirSync(start,{withFileTypes:true})){
  const name=join(start,e.name);
  if(e.isDirectory()){if(e.name!==".git"&&e.name!=="node_modules")out.push(...walk(name))}
  else if(e.isFile())out.push(name);
 }
 return out;
}
export function inspectPublicMaterial({root=ROOT}={}){
 const paths=PUBLIC_DIRS.flatMap(x=>walk(join(root,x)));
 // The root-level published pages are also source HTML pages.
 for(const e of readdirSync(root,{withFileTypes:true})){
  if(!e.isDirectory()||PUBLIC_DIRS.includes(e.name)||e.name.startsWith("."))continue;
  const f=join(root,e.name,"index.html");
  if(existsSync(f))paths.push(f);
 }
 const findings=[],scanned=[];
 for(const path of new Set(paths)){
  const name=relative(root,path).replaceAll("\\","/");
  if(EXT.test(name)){findings.push({file:name,kind:"public_binary",target:name});continue}
  if(!STATIC_EXT.test(name))continue;
  if(/(?:^|\/)(?:node_modules|test-fixtures)\//.test(name))continue;
  const buf=readFileSync(path);
  if(buf.length>5*1024*1024||buf.includes(0))continue;
  const body=buf.toString("utf8");
  scanned.push(name);
  for(const match of body.matchAll(URL_RE))
   findings.push({file:name,kind:"direct_download_url",target:match[0].slice(0,320)});
  for(const match of body.matchAll(HREF_RE)){
   const target=match[1];
   if(EXT.test(target.split("#")[0]))findings.push({file:name,kind:"linked_download",target:target.slice(0,320)});
  }
  if(/\bdownload\s*=\s*["'][^"']*["']/i.test(body) && LINK_RE.test(body))
   findings.push({file:name,kind:"download_attribute",target:"attribute"});
 }
 const dedup=[...new Map(findings.map(x=>[JSON.stringify(x),x])).values()];
 return {scan:"nc015-public-artifacts/v1",scanned_text_files:scanned.length,findings:dedup,
  result:dedup.length?"REVIEW_REQUIRED":"NO_DIRECT_PUBLIC_BINARY_OR_LINK_IN_REPOSITORY",
  coverage:"git checkout only; Hotmart Club and live deployments NOT measured"};
}
if(process.argv[1]===fileURLToPath(import.meta.url)){
 const outcome=inspectPublicMaterial();
 console.log(JSON.stringify(outcome));
 if(outcome.findings.length)process.exitCode=1;
}
