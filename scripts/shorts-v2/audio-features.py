"""Local DSP + pinned YAMNet/LiteRT. Probabilistic vocal detection; unknown blocks discovery."""
import hashlib,json,pathlib,re,subprocess,sys,zipfile
import numpy as np
from ai_edge_litert.interpreter import Interpreter
MODEL_SHA='4d8b4a53282dc83ef04e3e7dbc4fbc98082e34e44ed798e16c3a0cdd4c584faf'
file,model=sys.argv[1:3]
if hashlib.sha256(pathlib.Path(model).read_bytes()).hexdigest()!=MODEL_SHA:raise ValueError('vocal_model_hash_mismatch')
raw=subprocess.check_output(['ffmpeg','-v','error','-i',file,'-f','f32le','-ac','1','-ar','16000','pipe:1'])
a=np.frombuffer(raw,dtype='<f4');sr=16000
if len(a)<sr*20 or len(a)>sr*41:raise ValueError('audio_feature_duration_invalid')
rms=float(np.sqrt(np.mean(a*a)));hop=160
energy=np.sqrt(np.mean(a[:len(a)//hop*hop].reshape(-1,hop)**2,axis=1));onset=np.maximum(0,np.diff(energy));corr=np.correlate(onset,onset,'full')[len(onset)-1:];lags=np.arange(33,101);bpm=6000/int(lags[np.argmax(corr[lags])])
frames=np.lib.stride_tricks.sliding_window_view(a,2048)[::512];mag=np.abs(np.fft.rfft(frames*np.hanning(2048),axis=1));freq=np.fft.rfftfreq(2048,1/sr);den=mag.sum(axis=1);centroid=float(np.mean((mag*freq).sum(axis=1)/np.maximum(den,1e-12)))
chroma=np.zeros(12)
for i,f in enumerate(freq):
 if 65<=f<=4000:chroma[int(round(69+12*np.log2(f/440)))%12]+=mag[:,i].sum()
major=np.array([6.35,2.23,3.48,2.33,4.38,4.09,2.52,5.19,2.39,3.66,2.29,2.88]);minor=np.array([6.33,2.68,3.52,5.38,2.60,3.53,2.54,4.75,3.98,2.69,3.34,3.17]);keys=[(float(np.corrcoef(chroma,np.roll(t,k))[0,1]),mode,k) for mode,t in [('maior',major),('menor',minor)] for k in range(12)];keys.sort(reverse=True)
ebur=subprocess.run(['ffmpeg','-hide_banner','-nostats','-i',file,'-af','ebur128','-f','null','-'],capture_output=True,text=True,check=True).stderr
lra=float(re.findall(r'LRA:\s+([\d.]+) LU',ebur)[-1])
labels=zipfile.ZipFile(model).read('yamnet_label_list.txt').decode().splitlines();vocal=[i for i,s in enumerate(labels) if re.search(r'\b(speech|singing|choir|rapping|humming|chant|yodeling|beatboxing|mantra)\b',s,re.I)];music=labels.index('Music')
interpreter=Interpreter(model_path=model,num_threads=1);interpreter.allocate_tensors();inp=interpreter.get_input_details()[0];out=interpreter.get_output_details()[0];v=[];music_scores=[]
for start in range(0,len(a)-15600+1,7800):
 interpreter.set_tensor(inp['index'],a[start:start+15600].astype(np.float32));interpreter.invoke();scores=interpreter.get_tensor(out['index'])[0];v.append(float(max(scores[vocal])));music_scores.append(float(scores[music]))
vmax=max(v);status='presente' if vmax>=.25 else 'ausente' if np.mean(music_scores)>=.25 and vmax<.15 else 'incerto'
print(json.dumps({'schema':1,'audio_sha256':hashlib.sha256(pathlib.Path(file).read_bytes()).hexdigest(),'bpm':round(bpm,3),'rms':round(rms,7),'centroide_hz':round(centroid,3),'lra':lra,'modo':keys[0][1],'tonica':keys[0][2],'modo_confianca':round(keys[0][0]-keys[1][0],4),'vocal':{'status':status,'max_score':round(vmax,5),'music_mean':round(float(np.mean(music_scores)),5),'janelas':len(v),'model_sha256':MODEL_SHA},'metodo':'DSP v1 + YAMNet AudioSet 521/LiteRT 1.4.0; estimativas, nao garantia de ausencia de canto'}))
