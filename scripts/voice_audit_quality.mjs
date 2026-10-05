const values = Object.fromEntries([
 ['zero',0],['um',1],['dois',2],['tres',3],['quatro',4],['cinco',5],['seis',6],['sete',7],['oito',8],['nove',9],['dez',10],['onze',11],['doze',12],['treze',13],['quatorze',14],['catorze',14],['quinze',15],['dezesseis',16],['dezessete',17],['dezoito',18],['dezenove',19],['vinte',20],['trinta',30],['quarenta',40],['cinquenta',50],['sessenta',60],['setenta',70],['oitenta',80],['noventa',90],['cem',100],['cento',100],['duzentos',200],['trezentos',300],['quatrocentos',400],['quinhentos',500],['seiscentos',600],['setecentos',700],['oitocentos',800],['novecentos',900],
]);
export function tokens(text) {
 const words=String(text).normalize('NFD').replace(/\p{M}/gu,'').toLowerCase().replace(/\bi\s+a\b/g,'ia').replace(/\+/g,' mais ').replace(/&/g,' e ').match(/\d+(?:[.,]\d+)?|[a-z]+/g)||[];
 const out=[];
 for(let i=0;i<words.length;i++){
  if(values[words[i]]===undefined){out.push(words[i]);continue;}
  let n=values[words[i]];
  while(words[i+1]==='e'&&values[words[i+2]]!==undefined){n+=values[words[i+2]];i+=2;}
  out.push(String(n));
 }
 return out;
}
export function voiceQuality(expected,transcript){
 const a=tokens(expected),b=tokens(transcript);
 let row=Array.from({length:b.length+1},(_,i)=>i);
 for(let i=1;i<=a.length;i++){const next=[i];for(let j=1;j<=b.length;j++)next[j]=Math.min(row[j]+1,next[j-1]+1,row[j-1]+(a[i-1]===b[j-1]?0:1));row=next;}
 const numbers=x=>x.filter(t=>/^\d/.test(t)).map(t=>t.replace(',','.'));
 const wer=row[b.length]/Math.max(a.length,1),expected_numbers=numbers(a),actual_numbers=numbers(b);
 const numbers_identical=JSON.stringify(expected_numbers)===JSON.stringify(actual_numbers);
 return {wer,expected_numbers,actual_numbers,numbers_identical,pass:wer<=0.10&&numbers_identical};
}
