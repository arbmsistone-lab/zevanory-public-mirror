import test from 'node:test';
import assert from 'node:assert/strict';
import {evaluateConversationQuality,ELITE_CONVERSATION_POLICY} from '../src/conversationQuality.mjs';
import {AGENT_SYSTEM_POLICY} from '../src/agentPolicy.mjs';

const ok=(message,extra={})=>evaluateConversationQuality({message,channel:'whatsapp',recentMessages:[],decision:{confidence:.9},...extra});

test('elite policy is versioned and strict',()=>{
  assert.equal(ELITE_CONVERSATION_POLICY.version,'elite-conversation-v1');
  assert.ok(ELITE_CONVERSATION_POLICY.max_recent_similarity<.8);
});

test('natural concise response passes',()=>{
  const r=ok('Entendi sua dúvida sobre o valor. Posso explicar exatamente o que está incluído e, se fizer sentido, você decide o próximo passo.');
  assert.equal(r.pass,true);assert.equal(r.score,1);
});

test('robotic language is blocked',()=>assert.equal(ok('Prezado cliente, venho por meio desta informar que sua solicitação foi recebida.').pass,false));
test('fake urgency is blocked',()=>assert.equal(ok('É a última chance! Você vai perder esta oportunidade agora!').pass,false));
test('guarantee language is blocked',()=>assert.equal(ok('O resultado é 100% garantido e sem risco para você.').pass,false));
test('excessive uppercase is blocked',()=>assert.equal(ok('ATENÇÃO VOCÊ PRECISA DECIDIR AGORA SOBRE ESSA OFERTA').pass,false));
test('too many questions are blocked',()=>assert.equal(ok('Qual é sua dúvida? Qual seu orçamento? Quando quer começar?').pass,false));
test('low-information greeting is blocked',()=>assert.equal(ok('Olá!').pass,false));
test('low confidence customer message is blocked',()=>assert.equal(evaluateConversationQuality({message:'Posso te ajudar com isso agora.',channel:'whatsapp',decision:{confidence:.2}}).pass,false));

test('recent repetition is blocked',()=>{
  const msg='Posso explicar o que está incluído e você decide com calma o próximo passo.';
  const r=evaluateConversationQuality({message:msg,channel:'whatsapp',recentMessages:[msg],decision:{confidence:.9}});
  assert.equal(r.pass,false);assert.ok(r.issues.includes('recent_message_repetition'));
});

test('context-aware alternative avoids repetition',()=>{
  const recent=['Posso explicar o que está incluído e você decide com calma o próximo passo.'];
  const r=evaluateConversationQuality({message:'Sobre sua dúvida de preço: o ponto principal é entender o que você precisa antes de comparar opções.',channel:'whatsapp',recentMessages:recent,decision:{confidence:.9}});
  assert.equal(r.pass,true);
});

test('system policy requires continuity, objections and no manipulation',()=>{
  assert.match(AGENT_SYSTEM_POLICY,/recent_conversation/);
  assert.match(AGENT_SYSTEM_POLICY,/objections/i);
  assert.match(AGENT_SYSTEM_POLICY,/fake urgency/i);
  assert.match(AGENT_SYSTEM_POLICY,/Brazilian Portuguese/i);
});
