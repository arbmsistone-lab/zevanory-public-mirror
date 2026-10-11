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
