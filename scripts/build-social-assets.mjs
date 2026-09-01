import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const root=process.cwd();
const brandDir=path.join(root,'brand','social');
const publicDir=path.join(root,'public','brand','social');
fs.mkdirSync(brandDir,{recursive:true}); fs.mkdirSync(publicDir,{recursive:true});
const dataUri=(file)=>`data:image/svg+xml;base64,${fs.readFileSync(file).toString('base64')}`;
const mark=dataUri(path.join(root,'brand','official','zevanory-mark.svg'));
const logo=dataUri(path.join(root,'brand','official','zevanory-logo-dark.svg'));
const profile=`<svg xmlns="http://www.w3.org/2000/svg" width="1080" height="1080" viewBox="0 0 1080 1080"><rect width="1080" height="1080" fill="#05070A"/><image href="${mark}" x="160" y="160" width="760" height="760"/></svg>`;
const cover=`<svg xmlns="http://www.w3.org/2000/svg" width="1640" height="624" viewBox="0 0 1640 624"><rect width="1640" height="624" fill="#05070A"/><image href="${logo}" x="120" y="152" width="1400" height="320"/></svg>`;
const profileSvg=path.join(brandDir,'zevanory-social-profile-1080.svg'); const coverSvg=path.join(brandDir,'zevanory-facebook-cover-1640x624.svg');
fs.writeFileSync(profileSvg,profile,'utf8'); fs.writeFileSync(coverSvg,cover,'utf8');
const candidates=[process.env.CHROME_PATH,process.platform==='win32'?path.join(process.env.ProgramFiles||'','Google','Chrome','Application','chrome.exe'):null,'google-chrome','chromium','chromium-browser'].filter(Boolean);
const chrome=candidates.find((c)=>c.includes(path.sep)?fs.existsSync(c):spawnSync(c,['--version'],{encoding:'utf8'}).status===0); if(!chrome)throw new Error('chrome_not_found');
function shot(svg,out,w,h){const r=spawnSync(chrome,['--headless=new','--disable-gpu','--hide-scrollbars','--no-first-run','--force-device-scale-factor=1',`--window-size=${w},${h}`,`--screenshot=${out}`,pathToFileURL(svg).href],{encoding:'utf8'});if(r.status!==0)throw new Error(r.stderr||'chrome_screenshot_failed');}
shot(profileSvg,path.join(publicDir,'zevanory-social-profile-1080.png'),1080,1080); shot(coverSvg,path.join(publicDir,'zevanory-facebook-cover-1640x624.png'),1640,624);
console.log('SOCIAL_ASSETS_BUILD_PASS');
