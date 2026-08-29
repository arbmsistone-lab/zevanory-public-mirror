export function normalizeKnowledgeQuery(query) {
  return String(query || '').normalize('NFKC').replace(/[\u0000-\u001f\u007f]/g, ' ').trim().slice(0, 500);
}

export async function searchKnowledge(sql, query, limit = 6) {
  const q = normalizeKnowledgeQuery(query);
  if (!q) return [];
  const safeLimit = Math.max(1, Math.min(12, Number(limit) || 6));
  return sql.query(`
    select document_id, namespace, title, content, source_ref, trust_level,
      ts_rank_cd(search_vector, plainto_tsquery('portuguese',$1)) as rank
    from knowledge_documents
    where active=true and search_vector @@ plainto_tsquery('portuguese',$1)
    order by rank desc, updated_at desc
    limit $2
  `,[q,safeLimit]);
}

export function knowledgeContext(rows = []) {
  return rows.map((row) => ({
    title:String(row.title||''), namespace:String(row.namespace||''),
    trust_level:String(row.trust_level||''), source_ref:row.source_ref||null,
    content:String(row.content||'').slice(0,4000),
  }));
}
