import { inflateSync } from 'node:zlib';

const SIGNATURE=Buffer.from([137,80,78,71,13,10,26,10]);
const paeth=(a,b,c)=>{const p=a+b-c,pa=Math.abs(p-a),pb=Math.abs(p-b),pc=Math.abs(p-c);return pa<=pb&&pa<=pc?a:pb<=pc?b:c;};
const channels=(type)=>({0:1,2:3,4:2,6:4})[type]||0;

export function decodePngRgba(buffer){
  const b=Buffer.from(buffer||[]);if(b.length<33||!b.subarray(0,8).equals(SIGNATURE))throw new Error('png_signature_invalid');
  let off=8,width=0,height=0,bitDepth=0,colorType=-1,interlace=0;const idat=[];
  while(off+12<=b.length){const len=b.readUInt32BE(off),type=b.toString('ascii',off+4,off+8),data=b.subarray(off+8,off+8+len);off+=12+len;
    if(type==='IHDR'){width=data.readUInt32BE(0);height=data.readUInt32BE(4);bitDepth=data[8];colorType=data[9];interlace=data[12];}
    else if(type==='IDAT')idat.push(data); else if(type==='IEND')break;}
  const c=channels(colorType);if(!width||!height||bitDepth!==8||!c||interlace!==0)throw new Error('png_format_unsupported');
  const stride=width*c,raw=inflateSync(Buffer.concat(idat)),rows=[];let pos=0,prev=Buffer.alloc(stride);
  for(let y=0;y<height;y++){const filter=raw[pos++],row=Buffer.alloc(stride);for(let x=0;x<stride;x++){const v=raw[pos++],left=x>=c?row[x-c]:0,up=prev[x]||0,ul=x>=c?prev[x-c]:0;row[x]=(v+(filter===0?0:filter===1?left:filter===2?up:filter===3?Math.floor((left+up)/2):filter===4?paeth(left,up,ul):(()=>{throw new Error('png_filter_invalid')})()))&255;}rows.push(row);prev=row;}
  return Object.freeze({width,height,colorType,channels:c,rows:Object.freeze(rows)});
}
const lum=(r,g,b)=>.2126*r+.7152*g+.0722*b;
const rgbaAt=(row,x,type)=>{if(type===6){const i=x*4;return [row[i],row[i+1],row[i+2],row[i+3]];}if(type===2){const i=x*3;return [row[i],row[i+1],row[i+2],255];}if(type===4){const i=x*2;return [row[i],row[i],row[i],row[i+1]];}return [row[x],row[x],row[x],255];};

export function pngVisualMetrics(buffer,{targetSamples=18000}={}){
  const png=decodePngRgba(buffer),step=Math.max(1,Math.floor(Math.sqrt((png.width*png.height)/targetSamples)));
  const bg=rgbaAt(png.rows[0],0,png.colorType),bgLum=lum(bg[0],bg[1],bg[2]);let n=0,sum=0,sum2=0,min=255,max=0,edges=0,occupied=0,prev=null;
  for(let y=0;y<png.height;y+=step){const row=png.rows[y];for(let x=0;x<png.width;x+=step){const [r,g,b,a]=rgbaAt(row,x,png.colorType),v=a===0?bgLum:lum(r,g,b);n++;sum+=v;sum2+=v*v;min=Math.min(min,v);max=Math.max(max,v);if(Math.abs(v-bgLum)>18)occupied++;if(prev!==null&&Math.abs(v-prev)>28)edges++;prev=v;}}
  const mean=sum/Math.max(1,n),std=Math.sqrt(Math.max(0,sum2/Math.max(1,n)-mean*mean));
  return Object.freeze({width:png.width,height:png.height,luminance_mean:mean,luminance_std:std,dynamic_range:max-min,edge_density:edges/Math.max(1,n-1),occupied_fraction:occupied/Math.max(1,n)});
}