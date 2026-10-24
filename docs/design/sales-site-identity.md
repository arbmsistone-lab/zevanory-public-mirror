# ZEVANORY sales site: visual identity

Status: plan written before the build (PR-2 of the sales UX work, 2026-10-24).
Scope: `product.css` (shared design system), `legal.css`, the page templates the sales build
publishes (`solucoes/`, `zevanory-sales/`, the five product pages, the legal pages) and the
build steps in `scripts/build_sales_public.py` that inject commerce blocks.
Out of scope: products, prices, claims, legal substance, the brand logo files.

## 1. Who the page is for

The reader owns a salão, an oficina, a clínica or a loja in Brazil. They run the counter
themselves. They open the site on a mid-range phone, often between two customers, sometimes
in direct sunlight. In a few seconds they need to:

1. recognise their own problem;
2. find the product that solves that problem;
3. trust the company behind it: a small, real business with a CNPJ, one founder
   (Renan Bitu, Várzea Alegre, Ceará), plain terms and a 7-day right of withdrawal.

Everything on the page serves those three steps. Anything that doesn't is removed.

## 2. What we rejected as generic, and why

The current look is the default 2024 SaaS template. Every item below says "software startup"
and nothing about the reader's counter.

| Rejected | Why |
| --- | --- |
| Near-black background, cyan/blue glow, radial gradient blobs | Signals "dev tool". It reads poorly in sunlight and has nothing to do with a shop counter. |
| Gradient buttons with a glow shadow | Every CTA shouts equally, so none of them is primary. |
| Nine identical rounded cards in a grid | Flattens a catalogue that has real hierarchy: three paid products, two bundles, one subscription, three "em breve" items and free tools all get equal weight. |
| All-caps tracked eyebrow above every heading ("PORTFÓLIO OFICIAL", "O PROBLEMA") | Adds noise and repeats the heading. Removed everywhere. |
| "→" after every link | A glyph tic. A link that says what happens needs no arrow. |
| One 22–28 px radius on everything | Makes the page feel like soft plastic. Radii now follow the object: square for paper (receipt, tables), 6 px for controls. |
| A gradient on a single word of the headline | A decorative trick that also hurts legibility. |
| Fade-in on every section | Motion with no meaning. The site has no entrance animations at all. |
| "Vendas temporariamente fechadas" on every card, in the hero, in the aside and in the buy bar | Reads as nervous repetition. It is now one honest notice per page. The legal "Resumo da oferta" keeps its "Disponibilidade" field, because the decree requires it. |
| Warm cream "artisan" base | The other cliché. A cool, paper-white base is closer to receipt paper and to the counter's fluorescent light. |

## 3. Concept: the counter (balcão)

The visual vernacular comes from the place where the reader works:

- **cupom / recibo**: thermal receipt paper, monospaced alignment, dotted leaders between an
  item and its value, a torn edge;
- **caderno de caixa**: ruled lines and plain tabular numbers;
- **Brazilian banknotes**: the blue of the R$ 100 note as the one brand colour;
- **the yellow of the cash-register key / maquininha button**: the one key you press to finish.

One memorable element carries the concept: **the hero is a receipt** listing everyday problems,
each line printed like an item, with a dotted leader to the product that solves it. Everything
else stays quiet and disciplined: white paper, ink, blue for links, and yellow only once.

## 4. Tokens

### Colour (6 named tokens)

| Token | Hex | Role | Contrast |
| --- | --- | --- | --- |
| `--papel` | `#EEF2F5` | page base: cool paper-white | — |
| `--cupom` | `#FFFFFF` | receipt and content surfaces | — |
| `--tinta` | `#0E1A2B` | text, rules, borders of the primary key | 15.5:1 on papel, 17.5:1 on cupom |
| `--grafite` | `#4A5568` | secondary text | 6.7:1 on papel, 7.5:1 on cupom |
| `--azul-cedula` | `#1A5A96` | links, secondary buttons, focus ring: the blue of the R$ 100 note, darkened for text | 6.3:1 on papel, white on it 7.1:1 |
| `--amarelo-caixa` | `#FFC72C` | the single most important action on a page | ink on it 11.2:1 |

Derived (not new hues): `--linha` (`#7A8899`, 3:1 component borders) and `--linha-suave`
(`#C5CFDA`, decorative dotted rules only, never the only cue for anything).

Rules:

- Yellow appears **once per viewport-sized page section, on one control**: the main call to action
  (the waiting-list button while sales are closed). The yellow key always has a 2 px ink border,
  because yellow on paper-white is only 1.4:1 and the boundary has to be visible (WCAG 1.4.11).
- Blue is for things you can click and for the focus ring. It is never a background block.
- No gradients, no glows, no shadows except one 1 px "paper lift" on the receipt.

### Type

- **Display: Archivo** (variable, `wdth` 75–100, `wght` 600–800; display use only, so the light weights and wide widths were cut to keep the file at 34 KB). A grotesque with a real width
  axis. Condensed widths echo price tags and receipt headers; it stays sturdy on cheap screens.
- **Body: Atkinson Hyperlegible Next** (variable, `wght` 400–700). Designed by the Braille
  Institute for low-vision legibility: open apertures, distinct `Il1` and `0O`. That is the right
  priority for owners reading on a phone in a bright shop. It is clearly different from Archivo,
  so the two roles never blur.
- Both are SIL OFL, **self-hosted as woff2** (`font-src 'self'`), subset to Basic Latin, Latin-1
  (all Portuguese diacritics: á â ã à ç é ê í ó ô õ ú ü) and typographic punctuation
  (– — ‘ ’ “ ” • …). Axis ranges are trimmed to what the CSS uses. Budget: under 90 KB for both
  files (shipped: 34 KB + 18 KB). Both are preloaded, `font-display: swap`, and fallback faces carry `size-adjust` so the
  swap barely moves the layout.
- Tabular numbers (`font-variant-numeric: tabular-nums`) for prices and the receipt.

Scale (1.25 ratio, fluid between 360 and 1440 px):

| Step | Use | Size |
| --- | --- | --- |
| `--t-0` | small print, receipt footers | 0.875 rem |
| `--t-1` | body | 1.0625 rem (17 px) |
| `--t-2` | lead, receipt lines | 1.25 rem |
| `--t-3` | h3 | 1.5 rem |
| `--t-4` | h2 | clamp(1.75 rem, 3.2vw, 2.4 rem) |
| `--t-5` | h1 | clamp(2.25 rem, 5.6vw, 3.9 rem) |

Measure: running text is capped at `66ch` (never above 80 characters per line). Headings are
capped at `22ch`.

### Space and shape

- 4 px base; steps 4, 8, 12, 16, 24, 32, 48, 72, 104.
- Radius follows the object: `0` for paper (receipt, notice, tables, offer summary), `6px` for
  controls (buttons, inputs, `details`). Nothing else is rounded.
- Container: `min(1120px, 100% - 32px)`, centred. 16 px side gutter on phones.
- Every interactive target is at least 44 × 44 px (internal standard, stricter than WCAG 2.5.8).

## 5. Layout

### Header (all sales pages)

```
+----------------------------------------------------------------------------------+
| [ZEVANORY logo]                       Soluções   Termos   [Falar com a gente]    |  ink bar
+----------------------------------------------------------------------------------+
| Vendas temporariamente fechadas. Os preços são informativos; entre na lista de   |  notice
| espera e avisamos por e-mail quando abrir.                                       |  (sales pages only)
+----------------------------------------------------------------------------------+
```

The header is a thin ink bar. The official logo is drawn for dark backgrounds, so it sits on
ink unchanged; the bar reads as the edge of the counter. The notice appears once, only on pages
that show prices, and the Worker removes it at request time when the owner opens sales
(`data-zev-closed`).

### Catalogue (`/solucoes`, also `/`)

Desktop (1440):

```
  O que está pesando hoje no seu negócio?           +-----------------------------------+
  Software, IA e planilhas para quem toca           |  PROBLEMAS DE HOJE   24/10 · balcão|
  salão, oficina, clínica ou loja. Escolha          |  - - - - - - - - - - - - - - - - - |
  pelo problema.                                    |  caixa sem conferir .. Lucro & Caixa|
                                                    |  cliente sem resposta .... Vendas  |
  [Ver o checklist grátis]  (yellow, the one key)   |  orçamento que sumiu ..... Vendas  |
                                                    |  IA testada e largada ...... IA    |
  Feito por Renan Bitu, Várzea Alegre (CE).          |  post sem ideia ...Conteúdo Pronto |
  CNPJ 69.077.233/0001-99.                           |  preço no chute ...... Calculadora |
                                                    |  - - - - - - - - - - - - - - - - - |
                                                    |  Tudo de uma vez ... Negócio Compl.|
                                                    +/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\+
  ------------------------------------------------------------------------------------
  Dinheiro e caixa
    Lucro & Caixa           R$ 247   Rotina semanal curta de caixa e margem.      (large)
    Calculadoras grátis              Preço, margem, equilíbrio, sem cadastro.      (row)
    ZEVANORY CFO            Em breve                                                (row, quiet)
  Vendas e atendimento
    Vendas na Prática       R$ 197   ...                                           (large)
    Conteúdo Pronto         R$ 197/mês ...                                         (row)
    ZEVANORY SALES          Em breve                                                (row, quiet)
  IA no dia a dia
    IA na Prática           R$ 197   ...                                           (large)
    IA por ramo                      40 guias grátis                               (row)
  Tudo junto
    Combo IA + Vendas  R$ 297 | Negócio Completo  R$ 397                           (2 cols)
  Por segmento
    ARBM Contador para Salões   Em breve                                            (row, quiet)
  ------------------------------------------------------------------------------------
  Quem está por trás  [photo]  Renan Bitu ...
  ------------------------------------------------------------------------------------
  footer: razão social · CNPJ · endereço · suporte@ · Atendimento com protocolo
```

Phone (360): the receipt comes first, under a one-line headline, because recognising the problem
is the job. The intro copy and the yellow key follow. Catalogue groups stack; every row is one
44 px+ link.

```
+------------------------------+
| [logo]        [Falar]        |
+------------------------------+
| Vendas temporariamente ...   |
+------------------------------+
| O que está pesando hoje?     |
| +--------------------------+ |
| | PROBLEMAS DE HOJE        | |
| | caixa sem conferir       | |
| |   ......... Lucro & Caixa| |
| | cliente sem resposta     | |
| |   ......... Vendas       | |
| | ...                      | |
| +/\/\/\/\/\/\/\/\/\/\/\/\/\+ |
| [Ver o checklist grátis]     |
| Dinheiro e caixa             |
|  Lucro & Caixa      R$ 247   |
|  ...                         |
+------------------------------+
```

### Product page (`/ia-na-pratica` and the other four)

```
  IA na Prática                                    +-------------------------------+
  Pare de testar IA. Comece a usar com método.     | O QUE VOCÊ RECEBE      R$ 197 |
  lead paragraph (66ch max)                        | - - - - - - - - - - - - - - - |
  [Entrar na lista de espera] (yellow)             | Manual completo (PDF e DOCX)  |
  [Ver como funciona] (blue outline)               | Guia rápido em PDF            |
  Pagamento pelo Mercado Pago · entrega ...        | ...                           |
                                                   | pagamento único               |
                                                   +/\/\/\/\/\/\/\/\/\/\/\/\/\/\/\+
  ---- trust strip: 4 facts in a ruled row (no cards) ----
  Para quem é / Não é para você se   (two ruled columns, no card chrome)
  O problema (numbered list, ruled)
  Como funciona (3 steps as a ruled ledger)
  Oferta: what you get + Resumo da oferta (legal) + the yellow key
  Perguntas (details, 6 px radius)
```

The product's own receipt replaces the old glowing "hero panel": the list of deliverables
printed like items, with the price on the total line.

### Legal pages (`/termos`, `/privacidade`, `/reembolso`, `/afiliados`)

A single reading column (66ch), same type and colours, ink header bar, no decoration. Every
word of the legal text stays as is.

## 6. Principles

1. **Problem first.** The reader's words come before ours ("caixa sem conferir", not
   "inteligência financeira").
2. **One key.** One yellow action per page. Everything else is blue text or a blue outline.
3. **Paper, not plastic.** Square paper, rounded controls, no glow, no gradient, no shadow stacks.
4. **Say what happens.** Buttons describe the result: "Entrar na lista de espera", "Ver o
   checklist grátis", "Calcular meu preço". No "Saiba mais", no arrows.
5. **Honest status, once.** Closed sales are stated once, plainly, where prices are shown.
6. **Quiet motion.** Only hover/focus colour changes (≤ 120 ms); none with
   `prefers-reduced-motion`.
7. **Legibility over style.** 17 px body, 66ch measure, 44 px targets, a 3 px focus ring in
   R$ 100 blue that is never covered by the sticky header.

## 7. Copy rules

Plain Portuguese, sentence case, active verbs, "você". Remove internal jargon from public copy
("gates", "fail-closed", "guardrails", "evidência auditável") where it isn't a product name or a
legal term. Legal and consumer texts (termos, privacidade, reembolso, company identification,
the 7-day arrependimento, delivery in 72 h / one download) keep their substance; the build keeps
asserting them.

## 8. Engineering constraints the design respects

- CSP stays `default-src 'self'`; fonts are files under `/assets/fonts/`, hashed by the build and
  served `immutable`. No CDN.
- No inline style or script (the build rejects them).
- No WhatsApp, no phone number. Contact is `suporte@zevanory.api.br` and
  `https://zevanory.api.br/atendimento`.
- The closed build has no checkout link and no `InStock` (P13 grep gate).
- Budgets enforced in CI (`sales-ux-quality.yml`): Lighthouse ≥ 95 / 100 / 100 / 100, zero
  serious/critical axe findings, 44 px targets, visible and unobscured focus, reduced motion.

## 9. Self-critique after the first screenshots (what changed)

- **Removed decoration:** the 4 px blue stripe I had put on the left of every `.feature` block. It
  repeated the "accent bar on a card" cliché this plan rejects and added nothing a reader needs.
  Feature blocks are now plain paper.
- The receipt's dotted leaders collapsed when a problem wrapped to two lines; problems were cut to
  the reader's own short words ("caixa sem conferir") and the leader keeps a 24 px minimum.
- On phones the receipt first sat above the headline only through CSS `order`, which put the
  focus order out of step with what you see (WCAG 1.3.2 / 2.4.3). The DOM order is now
  headline, receipt, intro, and grid areas place them in two columns on wide screens.
- The closed-sales notice first sat outside every landmark (axe `region`); it is now the first
  element of `<main>`, read right after the skip link.
- The first font subset had lost the capital "A" (Archivo swaps it through a `rvrn` feature
  variation). The fonts were re-cut, instancing before subsetting, and every glyph in the range
  was checked.
- Known trade-off: Atkinson Hyperlegible Next draws zero with a slash, on purpose, so it can't be
  confused with "O". Prices and the receipt use Archivo's plain tabular figures.

## 10. Second review (coordinator critique, 2026-10-24)

- **Receipt on phones:** each line is now a two-row grid (problem, then a dotted leader to the
  product) with 64 px tall tap targets; the whole line is the link. The "toque no seu" label is gone.
- **Small text:** `--t-0` is 15 px on desktop and 16 px on phones; secondary text uses `--grafite`
  (6.7:1 on paper, 7.5:1 on white) at line-height 1.55.
- **Catalogue:** each lead product is a paper card with "what you get", taken from the real
  deliverable list in the build (`COMMERCE`), and a price column with the same width, size and
  alignment everywhere (price + "pagamento único"/"por mês"; "Grátis"; "Em breve" smaller and in
  graphite, names not link-blue). The whole card is the link.
  **Previews:** the repo has no screenshot or cover of any product material (only brand art in
  `assets/brand/export`), so none is shown; the typographic "o que você recebe" list stands in.
  No image, number, testimonial or rating was invented.
- **Footer:** company, contact and official profiles are three labelled blocks, not a "·" chain.
  The hero microcopy on product pages keeps its exact wording because the Worker rewrites that
  string for the Hotmart variant.
- **Rhythm:** section padding 72 → 48 px; the gap before "Quem criou" halved; the catalogue hero
  gets three plain facts (files, delivery, 7 days) so the text column balances the receipt.
- **Inner pages:** Conteúdo Pronto gets its own monthly receipt; the long legal offer column has a
  sticky companion on wide screens; /quem-criou is rebuilt (one h1, portrait, facts list, two
  sections, one action); the summary heading follows the h1 on Conteúdo Pronto (heading order).

## 11. Third review: read as a hostile buyer

What would still make a salão or oficina owner close the tab, and what was done about it.

| Doubt | Answer on the page now |
| --- | --- |
| "Is this a real company or a landing page that disappears?" | Every price sits next to a compact block: legal name, CNPJ, Várzea Alegre (CE), "empresa brasileira". The footer and /quem-criou carry the full block. /quem-criou has the founder's real photo, his own business (ARBM Bebidas) and the CNPJ. |
| "Who handles my money?" | "Pagamento processado pelo Mercado Pago" (Hotmart for Conteúdo Pronto), as text, with no third-party logos. /termos adds that the ZEVANORY never receives or stores card data, and /solucoes repeats it. |
| "What happens after I pay?" | "Como a compra funciona": pagamento → e-mail → link pessoal, valid 72 h and for one download (a new one at no cost if it expires) → 7 days to give up, with a full refund. |
| "If something goes wrong, will anyone answer?" | The support e-mail plus the documented commitment from /termos §8: confirmation on the spot and a conclusive answer within 5 days. The protocol form is in the footer. |
| "What exactly do I get?" | Each product lists its real files (manual, guia, planilha, comandos) in the hero receipt and the catalogue card. |
| "Can I see inside?" | **Not yet.** The deliverables (`ZEVANORY_<produto>_v1.1.zip`) live outside this repository, and no generator, template or source data for them exists here or in `zevanory-gestao`. We do not fake previews. The owner must supply the files listed in the PR (§ "Needs the owner"). Until then the gap stays visible: there is no "Veja por dentro" section. |
| "Why is it closed? Is it a scam collecting e-mails?" | One plain notice says sales are temporarily closed and prices are informative. The only action is a mailto to the official support address with a fixed subject; there is no form that collects data. |
| "These numbers look odd" (slashed zero) | All digits now use Archivo's plain figures through a `unicode-range` face, so the CNPJ, CEP and prices read as Brazilians write them. |
| "A 404 makes it look abandoned" | Unknown addresses get a designed 404 ("Cupom não localizado") with the way back to the catalogue, the founder and the terms. |

Signature interaction: on /solucoes each receipt line is an in-page link to the card of the product that
solves it. The card is marked with `:target` ("Seu problema: caixa sem conferir"), focus lands on it
(`tabindex="-1"`), and the scroll is instant under `prefers-reduced-motion`. No script is involved, so
it works with JavaScript off and needs no CSP change. Nothing else on the site moves.
