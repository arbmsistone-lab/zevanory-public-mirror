"""Tempo is an estimate. Edge peaks and weak/flat autocorrelation are not evidence."""
import numpy as np

def tempo_features(audio, sr=16000):
    hop=round(sr/100)
    if len(audio)<hop*200:return {'bpm':0.0,'bpm_confiavel':False,'bpm_confianca':0.0}
    energy=np.sqrt(np.mean(audio[:len(audio)//hop*hop].reshape(-1,hop)**2,axis=1))
    onset=np.maximum(0,np.diff(energy));corr=np.correlate(onset,onset,'full')[len(onset)-1:]
    lags=np.arange(33,101);values=corr[lags];idx=int(np.argmax(values));peak=float(values[idx]);confidence=peak/max(float(corr[0]),1e-20)
    prominence=(peak-float(np.median(values)))/max(peak,1e-20)
    reliable=bool(idx not in (0,len(lags)-1) and confidence>=.12 and prominence>=.15 and peak>1e-12 and float(np.std(energy))/max(float(np.mean(energy)),1e-12)>=.05)
    return {'bpm':round(6000/int(lags[idx]),3),'bpm_confiavel':reliable,'bpm_confianca':round(confidence,5)}
