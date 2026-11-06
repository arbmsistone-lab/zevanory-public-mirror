// ZEVANORY free calculators. No network, no storage: everything runs in the browser.
(function () {
  "use strict";
  function num(v) {
    var s = String(v == null ? "" : v).trim().replace(/[R$\s%]/g, "");
    if (s.indexOf(",") >= 0) s = s.replace(/\./g, "").replace(",", ".");
    else if (/^\d{1,3}(\.\d{3})+$/.test(s)) s = s.replace(/\./g, "");
    var n = Number(s);
    return Number.isFinite(n) ? n : NaN;
  }
  var brl = new Intl.NumberFormat("pt-BR", { style: "currency", currency: "BRL" });
  var pct = function (n) { return n.toLocaleString("pt-BR", { maximumFractionDigits: 1 }) + "%"; };
  var dec = function (n) { return n.toLocaleString("pt-BR", { minimumFractionDigits: 2, maximumFractionDigits: 2 }); };
  var CALC = {
    preco: function (v) {
      var soma = v.impostos + v.taxas + v.despesas + v.margem;
      if (!(v.custo > 0)) return ["Informe um custo maior que zero."];
      if ([v.impostos, v.taxas, v.despesas, v.margem].some(function (x) { return x < 0; })) return ["Os percentuais não podem ser negativos."];
      if (soma >= 100) return ["A soma dos percentuais é " + pct(soma) + ". Acima de 100% não existe preço que feche a conta: reduza despesas, taxas ou margem."];
      var preco = v.custo / (1 - soma / 100);
      return ["Preço de venda: " + brl.format(preco), "Markup: " + dec(preco / v.custo) + " (multiplique o custo por este número)", "Lucro por venda: " + brl.format(preco * v.margem / 100), "Impostos e taxas por venda: " + brl.format(preco * (v.impostos + v.taxas) / 100)];
    },
    margem: function (v) {
      if (!(v.preco > 0) || !(v.custo >= 0)) return ["Informe preço maior que zero e custo válido."];
      var lucro = v.preco - v.custo;
      var out = ["Lucro por venda: " + brl.format(lucro), "Margem de lucro: " + pct(lucro / v.preco * 100)];
      if (v.custo > 0) out.push("Markup: " + pct(lucro / v.custo * 100));
      if (lucro < 0) out.push("Atenção: você está vendendo abaixo do custo.");
      return out;
    },
    caixa: function (v) {
      if (![v.saldo, v.entradas, v.saidas].every(Number.isFinite) || v.entradas < 0 || v.saidas < 0) return ["Preencha os três valores."];
      var fim = v.saldo + v.entradas - v.saidas, dia = v.saidas / 30;
      var out = ["Saldo no fim do mês: " + brl.format(fim), "Resultado do mês (entradas − saídas): " + brl.format(v.entradas - v.saidas)];
      if (dia > 0) out.push(fim > 0 ? "Esse saldo cobre cerca de " + Math.floor(fim / dia).toLocaleString("pt-BR") + " dias de despesas." : "Atenção: vai faltar " + brl.format(-fim) + ". Antecipe recebimentos ou adie pagamentos.");
      return out;
    },
    hora: function (v) {
      if (!(v.horas > 0) || !(v.faturaveis > 0) || v.faturaveis > 100 || v.renda < 0 || v.fixos < 0 || v.impostos < 0 || v.impostos >= 100) return ["Revise os valores: horas e % faturável maiores que zero, impostos abaixo de 100%."];
      var horasMes = v.horas * 52 / 12 * v.faturaveis / 100, hora = (v.renda + v.fixos) / horasMes / (1 - v.impostos / 100);
      return ["Preço mínimo da hora: " + brl.format(hora), "Horas cobráveis no mês: cerca de " + Math.round(horasMes).toLocaleString("pt-BR"), "Meia diária (4 h): " + brl.format(hora * 4) + " · Diária (8 h): " + brl.format(hora * 8)];
    },
    maquininha: function (v) {
      if (!(v.valor > 0) || !(v.taxa >= 0) || v.taxa >= 100) return ["Informe valor maior que zero e taxa entre 0% e 100%."];
      var liq = v.valor * (1 - v.taxa / 100);
      return ["Cai na conta: " + brl.format(liq), "A maquininha fica com: " + brl.format(v.valor - liq), "Para receber " + brl.format(v.valor) + " líquidos, cobre " + brl.format(v.valor / (1 - v.taxa / 100))];
    },
    cmv: function (v) {
      if ([v.inicial, v.compras, v.final].some(function (x) { return x < 0; }) || !(v.faturamento > 0)) return ["Preencha os valores; o faturamento precisa ser maior que zero."];
      var cmv = v.inicial + v.compras - v.final;
      if (cmv < 0) return ["O estoque final está maior que o inicial mais as compras. Revise os valores."];
      return ["CMV do mês: " + brl.format(cmv), "CMV sobre o faturamento: " + pct(cmv / v.faturamento * 100), "Margem bruta: " + brl.format(v.faturamento - cmv) + " (" + pct((v.faturamento - cmv) / v.faturamento * 100) + ")"];
    },
    equilibrio: function (v) {
      if (!(v.fixos >= 0) || !(v.preco > 0) || !(v.variavel >= 0)) return ["Preencha os três valores com números válidos."];
      var contrib = v.preco - v.variavel;
      if (contrib <= 0) return ["O custo variável é maior ou igual ao preço: cada venda dá prejuízo. Revise preço ou custo."];
      var unidades = Math.ceil(v.fixos / contrib);
      return ["Vendas por mês no equilíbrio: " + unidades.toLocaleString("pt-BR"), "Faturamento mínimo: " + brl.format(unidades * v.preco), "Por dia útil (22 dias): cerca de " + Math.ceil(unidades / 22).toLocaleString("pt-BR") + " vendas", "Cada venda contribui com " + brl.format(contrib) + " para pagar os custos fixos."];
    }
  };
  function run(form) {
    var fn = CALC[form.getAttribute("data-calc")], out = form.querySelector(".calc-result");
    if (!fn || !out) return;
    var v = {};
    Array.prototype.forEach.call(form.querySelectorAll("input"), function (i) { v[i.name] = num(i.value); });
    var bad = Object.keys(v).filter(function (k) { return !Number.isFinite(v[k]); });
    var lines = bad.length ? ["Use apenas números (ex.: 1.250,50)."] : fn(v);
    while (out.firstChild) out.removeChild(out.firstChild);
    lines.forEach(function (t, idx) { var p = document.createElement("p"); if (idx === 0) p.className = "calc-main"; p.textContent = t; out.appendChild(p); });
  }
  Array.prototype.forEach.call(document.querySelectorAll("form.calc"), function (form) {
    form.addEventListener("submit", function (ev) { ev.preventDefault(); run(form); });
    form.addEventListener("input", function () { run(form); });
    run(form);
  });
  if (typeof module !== "undefined") module.exports = { num: num, CALC: CALC };
})();
