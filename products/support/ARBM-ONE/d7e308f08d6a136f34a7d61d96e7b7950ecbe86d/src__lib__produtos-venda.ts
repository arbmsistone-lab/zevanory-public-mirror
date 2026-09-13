export type ModoVendaProduto =
  | "unidade"
  | "pack"
  | "fardo"
  | "meia_caixa"
  | "caixa";

export type ProdutoVenda = {
  id: string;
  nome: string;
  categoria?: string | null;
  codigo_interno?: string | null;
  codigo_barras?: string | null;
  foto_url?: string | null;
  preco_venda: number;
  estoque_atual?: number;
  oferta_ativa?: boolean | null;
  preco_promocional_unitario?: number | null;

  permite_unidade?: boolean | null;
  permite_pack?: boolean | null;
  permite_fardo?: boolean | null;
  permite_meia_caixa?: boolean | null;
  permite_caixa?: boolean | null;

  unidades_pack?: number | null;
  preco_pack?: number | null;
  preco_promocional_pack?: number | null;

  unidades_fardo?: number | null;
  preco_fardo?: number | null;
  preco_promocional_fardo?: number | null;

  unidades_meia_caixa?: number | null;
  preco_meia_caixa?: number | null;
  preco_promocional_meia_caixa?: number | null;

  unidades_caixa?: number | null;
  preco_caixa?: number | null;
  preco_promocional_caixa?: number | null;

  // Campos antigos mantidos para compatibilidade.
  unidades_embalagem?: number | null;
  preco_embalagem?: number | null;
  preco_promocional_embalagem?: number | null;
  vender_por?: string | null;
};

export type OpcaoVendaProduto = {
  modo: ModoVendaProduto;
  rotulo: string;
  preco: number;
  unidades: number;
};

export function numeroSeguro(valor: unknown) {
  const numero = Number(valor ?? 0);
  return Number.isFinite(numero) ? numero : 0;
}

export function precoUnitarioAtivo(produto: ProdutoVenda) {
  if (
    produto.oferta_ativa &&
    numeroSeguro(produto.preco_promocional_unitario) > 0
  ) {
    return numeroSeguro(produto.preco_promocional_unitario);
  }

  return numeroSeguro(produto.preco_venda);
}

export function precoPorOpcao(
  produto: ProdutoVenda,
  normal?: number | null,
  promocional?: number | null,
) {
  if (produto.oferta_ativa && numeroSeguro(promocional) > 0) {
    return numeroSeguro(promocional);
  }

  return numeroSeguro(normal);
}

export function precoTotalEmbalagemPDV(
  precoInformado: number,
  unidades: number,
  precoUnidade: number,
) {
  const preco = numeroSeguro(precoInformado);
  const quantidade = Math.max(1, numeroSeguro(unidades));
  const unidade = numeroSeguro(precoUnidade);

  if (preco <= 0) return 0;

  // Preserva a heurística atual do PDV:
  // valor maior que o preço unitário é tratado como total da embalagem.
  if (unidade > 0 && preco > unidade) return preco;

  // Valor menor ou igual é tratado como preço por unidade da embalagem.
  return Math.round(preco * quantidade * 100) / 100;
}

export function precoUnitarioDaEmbalagemPDV(
  precoInformado: number,
  unidades: number,
  precoUnidade: number,
) {
  const quantidade = Math.max(1, numeroSeguro(unidades));
  const total = precoTotalEmbalagemPDV(
    precoInformado,
    quantidade,
    precoUnidade,
  );

  if (total <= 0) return 0;

  return Math.round((total / quantidade) * 1_000_000) / 1_000_000;
}

export function precoUnitarioPorQuantidade(
  produto: ProdutoVenda,
  quantidade: number,
) {
  const quantidadeNormalizada = Math.max(1, Number(quantidade || 1));
  const precoUnidade = precoUnitarioAtivo(produto);

  const unidadesPack = Math.max(
    1,
    numeroSeguro(produto.unidades_pack) || 6,
  );

  const precoPackInformado = precoPorOpcao(
    produto,
    produto.preco_pack,
    produto.preco_promocional_pack,
  );

  const precoPack = precoUnitarioDaEmbalagemPDV(
    precoPackInformado,
    unidadesPack,
    precoUnidade,
  );

  const unidadesFardo = Math.max(
    1,
    numeroSeguro(produto.unidades_fardo) ||
      numeroSeguro(produto.unidades_embalagem) ||
      24,
  );

  const precoFardoInformado = precoPorOpcao(
    produto,
    produto.preco_fardo ?? produto.preco_embalagem,
    produto.preco_promocional_fardo ??
      produto.preco_promocional_embalagem,
  );

  const precoFardo = precoUnitarioDaEmbalagemPDV(
    precoFardoInformado,
    unidadesFardo,
    precoUnidade,
  );

  const faixas = [
    {
      unidades: unidadesPack,
      preco: precoPack,
      rotulo: "Unidade com preço de pack",
      prioridade: 1,
    },
    {
      unidades: unidadesFardo,
      preco: precoFardo,
      rotulo: "Unidade com preço de fardo",
      prioridade: 2,
    },
  ]
    .filter(
      (faixa) =>
        faixa.preco > 0 &&
        quantidadeNormalizada >= faixa.unidades,
    )
    .sort(
      (a, b) =>
        b.unidades - a.unidades ||
        b.prioridade - a.prioridade,
    );

  const faixaAplicavel = faixas[0];

  if (faixaAplicavel) {
    return {
      preco: faixaAplicavel.preco,
      rotulo: faixaAplicavel.rotulo,
    };
  }

  return {
    preco: precoUnidade,
    rotulo: "Unidade",
  };
}

export function opcoesProduto(
  produto: ProdutoVenda,
): OpcaoVendaProduto[] {
  const opcoes: OpcaoVendaProduto[] = [];

  const precoUnitarioEmbalagem = (
    normal?: number | string | null,
    promocional?: number | string | null,
  ) => {
    const promocaoAtiva = Boolean(produto.oferta_ativa);
    const promocionalNormalizado = numeroSeguro(promocional);

    if (promocaoAtiva && promocionalNormalizado > 0) {
      return promocionalNormalizado;
    }

    return numeroSeguro(normal);
  };

  if ((produto.permite_unidade ?? true) !== false) {
    const regra = precoUnitarioPorQuantidade(produto, 1);

    if (regra.preco > 0) {
      opcoes.push({
        modo: "unidade",
        rotulo: regra.rotulo,
        preco: regra.preco,
        unidades: 1,
      });
    }
  }

  if (produto.permite_pack) {
    const unidades = Math.max(
      1,
      numeroSeguro(produto.unidades_pack) || 6,
    );
    const vendaUnitaria = precoUnitarioEmbalagem(
      produto.preco_pack,
      produto.preco_promocional_pack,
    );

    opcoes.push({
      modo: "pack",
      rotulo: "PACK",
      preco: precoTotalEmbalagemPDV(
        vendaUnitaria,
        unidades,
        precoUnitarioAtivo(produto),
      ),
      unidades,
    });
  }

  if (produto.permite_fardo) {
    const unidades = Math.max(
      1,
      numeroSeguro(produto.unidades_fardo) ||
        numeroSeguro(produto.unidades_embalagem) ||
        24,
    );
    const vendaUnitaria = precoUnitarioEmbalagem(
      produto.preco_fardo ?? produto.preco_embalagem,
      produto.preco_promocional_fardo ??
        produto.preco_promocional_embalagem,
    );

    opcoes.push({
      modo: "fardo",
      rotulo: "FARDO",
      preco: precoTotalEmbalagemPDV(
        vendaUnitaria,
        unidades,
        precoUnitarioAtivo(produto),
      ),
      unidades,
    });
  }

  if (produto.permite_meia_caixa) {
    const unidades = Math.max(
      1,
      numeroSeguro(produto.unidades_meia_caixa) || 12,
    );
    const vendaUnitaria = precoUnitarioEmbalagem(
      produto.preco_meia_caixa,
      produto.preco_promocional_meia_caixa,
    );

    opcoes.push({
      modo: "meia_caixa",
      rotulo: "MEIA CAIXA",
      preco: precoTotalEmbalagemPDV(
        vendaUnitaria,
        unidades,
        precoUnitarioAtivo(produto),
      ),
      unidades,
    });
  }

  if (produto.permite_caixa) {
    const unidades = Math.max(
      1,
      numeroSeguro(produto.unidades_caixa) || 24,
    );
    const vendaUnitaria = precoUnitarioEmbalagem(
      produto.preco_caixa,
      produto.preco_promocional_caixa,
    );

    opcoes.push({
      modo: "caixa",
      rotulo: "CAIXA",
      preco: precoTotalEmbalagemPDV(
        vendaUnitaria,
        unidades,
        precoUnitarioAtivo(produto),
      ),
      unidades,
    });
  }

  return opcoes;
}

export function estoqueDisponivel(produto: ProdutoVenda) {
  return Math.max(
    0,
    Math.floor(numeroSeguro(produto.estoque_atual)),
  );
}
