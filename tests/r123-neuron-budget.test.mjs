import test from "node:test";
import assert from "node:assert/strict";
import {reserveChatNeurons,CHAT_NEURON_DAILY_CEILING,CHAT_NEURON_RESERVATION} from "../worker/site-chat.mjs";
import {fakeSql} from "./helpers/site-chat-fakes.mjs";
test("R123 6000 neurons/day reserved atomically within chat namespace",async()=>{
 const sql=fakeSql(),now=Date.parse("2026-11-05T15:00:00Z");
 assert.equal(CHAT_NEURON_DAILY_CEILING,6000);
 const n=Math.floor(CHAT_NEURON_DAILY_CEILING/CHAT_NEURON_RESERVATION);
 for(let i=0;i<n;i++) assert.equal(await reserveChatNeurons(sql,now),true);
 assert.equal(await reserveChatNeurons(sql,now),false,"no extra AI call when over limit");
 assert.equal(sql.db.counters.get("g:chat:neurons:d|2026-11-05T00:00:00.000Z"),n*CHAT_NEURON_RESERVATION);
 assert.equal(sql.db.counters.get("g:ai:d"),undefined,"other AI consumers are not counted here");
 assert.equal(await reserveChatNeurons(sql,Date.parse("2026-11-06T00:00:00Z")),true,"UTC reset");
});
test("R123 missing counter database fails closed, never treats error as an approval",async()=>{
 await assert.rejects(()=>reserveChatNeurons({query:async()=>{throw Error("db down")}}));
});
