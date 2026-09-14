export function normalizeKnowledgeQuery(query) {
  return String(query || '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);
}
const tsTokens=(query)=>[...new Set(normalizeKnowledgeQuery(query).toLowerCase().normalize('NFKD').replace(/[\u0300-\u036f]/g,'').match(/[a-z0-9]{2,}/g)||[])].filter(x=>!['quero','saber','como','para','uma','uns','umas','dos','das','que','com','sem','isso','essa','esse','esta','este','pelo','pela','mais','sobre'].includes(x)).slice(0,18);

export async function searchKnowledge(sql, query, limit = 6) {
  const q = normalizeKnowledgeQuery(query);
  if (!q) return [];
  const safeLimit = Math.max(1, Math.min(12, Number(limit) || 6));
  const tokens=tsTokens(q); if(!tokens.length)return [];
  const ts=tokens.map(x=>`${x.replace(/[^a-z0-9]/g,'')}:*`).filter(Boolean).join(' | ');
  return sql.query(`
    select document_id, namespace, title, content, source_ref, trust_level,
      ts_rank_cd(search_vector, to_tsquery('portuguese',$1)) as rank
    from knowledge_documents
    where active=true and search_vector @@ to_tsquery('portuguese',$1)
    order by rank desc,
      case trust_level when 'official' then 0 when 'verified' then 1 when 'internal' then 2 else 3 end,
      updated_at desc
    limit $2
  `,[ts,safeLimit]);
}

export function knowledgeContext(rows = []) {
  return rows.map((row) => ({
    title:String(row.title||''), namespace:String(row.namespace||''),
    trust_level:String(row.trust_level||''), source_ref:row.source_ref||null,
    content:String(row.content||'').slice(0,4000),
  }));
}
