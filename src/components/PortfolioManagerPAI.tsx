import React, { useEffect, useMemo, useState } from "react";
import {
  PieChart, Pie, Cell, Tooltip, ResponsiveContainer,
  LineChart, Line, XAxis, YAxis, CartesianGrid, Legend,
  BarChart, Bar
} from "recharts";

/**
 * Portfolio Manager – Ações PAI (v1)
 * Sistema de gestão de portfólios com múltiplos portfólios,
 * transações, gatilhos, dividendos e análises gráficas.
 */

interface Transaction {
  id: string;
  date: string;
  ticker: string;
  type: "BUY" | "SELL";
  qty: number;
  price: number;
  fees?: number;
}
interface PriceNow {
  ticker: string;
  price: number;
  updatedAt: string;
}
interface Trigger {
  ticker: string;
  buyPrice?: number;
  sellPrice?: number;
  trailingStopPct?: number;
  note?: string;
}
interface DividendEntry {
  id: string;
  date: string;
  ticker: string;
  type: "ON" | "PN" | "UNIT" | "BDR" | "ETF" | "OUTRO";
  valuePerShare: number;
  note?: string;
}
interface PortfolioData {
  id: string;
  name: string;
  baseCurrency: string;
  transactions: Transaction[];
  prices: PriceNow[];
  triggers: Trigger[];
  dividends: DividendEntry[];
  history: { date: string; totalValue: number }[];
}

// Helpers
const uid = () => Math.random().toString(36).slice(2);
const todayISO = () => new Date().toISOString().slice(0, 10);
const CURRENCY = (x: number, currency = "BRL") =>
  x.toLocaleString("pt-BR", { style: "currency", currency });
const numberFmt = (x: number, digits = 2) =>
  x.toLocaleString("pt-BR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits
  });

const LS_KEY = "acoes_pai_portfolios_v1";
const loadAll = (): PortfolioData[] => {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return [];
  }
};
const saveAll = (data: PortfolioData[]) =>
  localStorage.setItem(LS_KEY, JSON.stringify(data));
// ================================
// Parte 2 — Cálculos e utilitários
// ================================

// Posição agregada por ticker
export type Position = {
  ticker: string;
  qty: number;
  invested: number;       // custo total (com taxas)
  avgPrice: number;       // preço médio
  lastPrice: number;      // cotação atual (informada manualmente)
  mktValue: number;       // valor de mercado
  pl: number;             // lucro/prejuízo não realizado
  plPct: number;          // % sobre o custo
  divsTotal: number;      // total de dividendos recebidos
  divYieldOnCost: number; // dividendos / custo
  signal: "BUY" | "SELL" | "HOLD" | "STOP";
  trigger?: Trigger;
};

// Agrega transações em posições por ticker + aplica gatilhos
export function aggregatePositions(p: PortfolioData): Position[] {
  const txByTicker = new Map<string, Transaction[]>();
  for (const t of p.transactions) {
    if (!txByTicker.has(t.ticker)) txByTicker.set(t.ticker, []);
    txByTicker.get(t.ticker)!.push(t);
  }

  const priceMap = new Map(p.prices.map((x) => [x.ticker, x.price] as const));
  const trigMap  = new Map(p.triggers.map((x) => [x.ticker, x] as const));

  // Soma dividendos considerando a quantidade detida na data do pagamento
  const divByTicker = new Map<string, number>();
  for (const d of p.dividends) {
    const q = shareCountAtDate(p.transactions, d.ticker, d.date);
    const amt = q * d.valuePerShare;
    divByTicker.set(d.ticker, (divByTicker.get(d.ticker) || 0) + amt);
  }

  const positions: Position[] = [];

  for (const [ticker, list] of txByTicker) {
    // média ponderada simples (com ajuste proporcional em venda)
    let qty = 0;
    let cost = 0;
    for (const t of list) {
      const fees = t.fees || 0;
      if (t.type === "BUY") {
        qty  += t.qty;
        cost += t.qty * t.price + fees;
      } else {
        // venda: reduz quantidade e retira custo médio proporcional
        const avg = qty > 0 ? cost / qty : 0;
        qty  -= t.qty;
        cost -= avg * t.qty;
        cost += fees; // taxas de venda agregadas ao custo residual
      }
    }

    const avgPrice   = qty > 0 ? cost / Math.max(qty, 1) : 0;
    const lastPrice  = priceMap.get(ticker) || 0;
    const mktValue   = qty * lastPrice;
    const pl         = mktValue - cost;
    const plPct      = cost > 0 ? (pl / cost) * 100 : 0;
    const divs       = divByTicker.get(ticker) || 0;
    const dyOnCost   = cost > 0 ? divs / cost : 0;

    const tr = trigMap.get(ticker);
    let signal: Position["signal"] = "HOLD";
    if (tr) {
      if (tr.buyPrice  != null && lastPrice > 0 && lastPrice <= tr.buyPrice)  signal = "BUY";
      if (tr.sellPrice != null && lastPrice > 0 && lastPrice >= tr.sellPrice) signal = "SELL";
      if (tr.trailingStopPct != null && tr.trailingStopPct > 0 && lastPrice > 0) {
        // Simplificação: se o P/L% ficou <= -stop%, sinal STOP
        if (plPct <= -tr.trailingStopPct) signal = "STOP";
      }
    }

    positions.push({
      ticker,
      qty,
      invested: cost,
      avgPrice,
      lastPrice,
      mktValue,
      pl,
      plPct,
      divsTotal: divs,
      divYieldOnCost: dyOnCost,
      signal,
      trigger: tr
    });
  }

  // inclui tickers com preço/trigger mas sem transações (monitoramento)
  for (const pr of p.prices) {
    if (!positions.find((x) => x.ticker === pr.ticker)) {
      const tr = p.triggers.find((t) => t.ticker === pr.ticker);
      positions.push({
        ticker: pr.ticker,
        qty: 0,
        invested: 0,
        avgPrice: 0,
        lastPrice: pr.price,
        mktValue: 0,
        pl: 0,
        plPct: 0,
        divsTotal: 0,
        divYieldOnCost: 0,
        signal:
          tr?.buyPrice  && pr.price <= tr.buyPrice  ? "BUY" :
          tr?.sellPrice && pr.price >= tr.sellPrice ? "SELL" : "HOLD",
        trigger: tr
      });
    }
  }

  return positions.sort((a, b) => a.ticker.localeCompare(b.ticker));
}

// Quantidade detida até certa data (para cálculo de dividendos)
export function shareCountAtDate(transactions: Transaction[], ticker: string, dateISO: string) {
  const d = new Date(dateISO);
  let q = 0;
  for (const t of transactions) {
    if (t.ticker !== ticker) continue;
    if (new Date(t.date) <= d) q += t.type === "BUY" ? t.qty : -t.qty;
  }
  return Math.max(q, 0);
}

// Importa CSV (date,ticker,type,qty,price,fees)
export function csvToTransactions(csv: string): Transaction[] {
  const rows = csv.split(/\r?\n/).map(r => r.trim()).filter(Boolean);
  const out: Transaction[] = [];
  const header = rows.shift()?.toLowerCase() || "";
  const idx = (name: string) => header.split(",").findIndex(h => h.trim() === name);

  const idDate  = idx("date");
  const idTick  = idx("ticker");
  const idType  = idx("type");
  const idQty   = idx("qty");
  const idPrice = idx("price");
  const idFees  = idx("fees");

  for (const r of rows) {
    const parts  = r.split(",");
    const date   = parts[idDate]?.trim() || todayISO();
    const ticker = (parts[idTick]?.trim() || "").toUpperCase();
    const type   = (parts[idType]?.trim().toUpperCase() === "SELL" ? "SELL" : "BUY") as Transaction["type"];
    const qty    = Number(parts[idQty] || 0);
    const price  = Number(parts[idPrice] || 0);
    const fees   = idFees >= 0 ? Number(parts[idFees] || 0) : 0;
    if (!ticker) continue;
    out.push({ id: uid(), date, ticker, type, qty, price, fees });
  }
  return out;
}

// Download helper (JSON)
export function download(filename: string, data: string) {
  const blob = new Blob([data], { type: "application/json;charset=utf-8" });
  const url  = URL.createObjectURL(blob);
  const a    = document.createElement("a");
  a.href = url; a.download = filename; a.click();
  URL.revokeObjectURL(url);
}

// Upsert genérico
export function upsert<T>(arr: T[], match: (x: T) => boolean, next: T): T[] {
  const i = arr.findIndex(match);
  if (i === -1) return [...arr, next];
  const copy = [...arr];
  copy[i] = next;
  return copy;
}
// ================================
// Parte 3 — UI + Componente principal (1/2)
// Cabeçalhos, abas, visão geral e posições
// ================================

// Pequenos componentes de UI
const Badge: React.FC<{
  children: React.ReactNode;
  tone?: "neutral" | "success" | "danger" | "warning";
}> = ({ children, tone = "neutral" }) => {
  const map = {
    neutral: "bg-gray-100 text-gray-800",
    success: "bg-green-100 text-green-800",
    danger: "bg-red-100 text-red-800",
    warning: "bg-yellow-100 text-yellow-800"
  } as const;
  return (
    <span className={`px-2 py-0.5 rounded-full text-xs font-medium ${map[tone]}`}>
      {children}
    </span>
  );
};

const Card: React.FC<{
  title?: string;
  right?: React.ReactNode;
  children: React.ReactNode;
  className?: string;
}> = ({ title, right, children, className = "" }) => (
  <div className={`rounded-2xl shadow-sm border border-gray-100 bg-white p-4 ${className}`}>
    {(title || right) && (
      <div className="flex items-center justify-between mb-3">
        {title && <h3 className="text-sm font-semibold text-gray-900">{title}</h3>}
        {right}
      </div>
    )}
    {children}
  </div>
);

const Tabs: React.FC<{
  tabs: string[];
  value: string;
  onChange: (t: string) => void;
}> = ({ tabs, value, onChange }) => (
  <div className="flex gap-2 mb-4 flex-wrap">
    {tabs.map((t) => (
      <button
        key={t}
        onClick={() => onChange(t)}
        className={`px-3 py-1.5 rounded-full text-sm border transition ${
          value === t
            ? "bg-gray-900 text-white border-gray-900"
            : "bg-white hover:bg-gray-50 border-gray-200"
        }`}
      >
        {t}
      </button>
    ))}
  </div>
);

const COLORS = [
  "#5B8FF9",
  "#61DDAA",
  "#65789B",
  "#F6BD16",
  "#7262fd",
  "#78D3F8",
  "#9661BC",
  "#F6903D",
  "#008685",
  "#F08BB4"
];

// ================================
// Componente principal
// ================================
export default function PortfolioManagerPAI() {
  // Estado: múltiplos portfólios
  const [data, setData] = useState<PortfolioData[]>([]);
  const [sel, setSel] = useState<string>("");
  const [tab, setTab] = useState("Visão Geral");

  // Carrega do localStorage / cria demo
  useEffect(() => {
    const loaded = loadAll();
    if (loaded.length === 0) {
      const demo: PortfolioData = {
        id: uid(),
        name: "Portfólio Principal",
        baseCurrency: "BRL",
        transactions: [
          { id: uid(), date: todayISO(), ticker: "PETR4", type: "BUY", qty: 100, price: 37.5 },
          { id: uid(), date: todayISO(), ticker: "VALE3", type: "BUY", qty: 20, price: 62.2 }
        ],
        prices: [
          { ticker: "PETR4", price: 38.1, updatedAt: new Date().toISOString() },
          { ticker: "VALE3", price: 61.8, updatedAt: new Date().toISOString() }
        ],
        triggers: [
          { ticker: "PETR4", buyPrice: 37.0, sellPrice: 42.0, trailingStopPct: 8, note: "Faixa tática" },
          { ticker: "VALE3", buyPrice: 60.0, sellPrice: 68.0 }
        ],
        dividends: [
          { id: uid(), date: todayISO(), ticker: "PETR4", type: "PN", valuePerShare: 0.75 }
        ],
        history: []
      };
      setData([demo]);
      setSel(demo.id);
    } else {
      setData(loaded);
      setSel(loaded[0]?.id || "");
    }
  }, []);

  // Persiste alterações
  useEffect(() => {
    if (data.length > 0) saveAll(data);
  }, [data]);

  const current = useMemo(
    () => data.find((p) => p.id === sel) || null,
    [data, sel]
  );

  // Ações de portfólio
  const newPortfolio = () => {
    const name = prompt("Nome do novo portfólio:", `Portfólio ${data.length + 1}`);
    if (!name) return;
    const p: PortfolioData = {
      id: uid(),
      name,
      baseCurrency: "BRL",
      transactions: [],
      prices: [],
      triggers: [],
      dividends: [],
      history: []
    };
    setData((d) => [...d, p]);
    setSel(p.id);
  };

  const renamePortfolio = () => {
    if (!current) return;
    const name = prompt("Novo nome:", current.name);
    if (!name) return;
    setData((d) => d.map((p) => (p.id === current.id ? { ...p, name } : p)));
  };

  const deletePortfolio = () => {
    if (!current) return;
    if (!confirm(`Remover "${current.name}"?`)) return;
    const rest = data.filter((p) => p.id !== current.id);
    setData(rest);
    setSel(rest[0]?.id || "");
  };

  // CRUD básico
  const addTx = (tx: Omit<Transaction, "id">) => {
    if (!current) return;
    const n: Transaction = { id: uid(), ...tx };
    setData((d) =>
      d.map((p) =>
        p.id === current.id ? { ...p, transactions: [...p.transactions, n] } : p
      )
    );
  };

  const removeTx = (id: string) =>
    current &&
    setData((d) =>
      d.map((p) =>
        p.id === current.id
          ? { ...p, transactions: p.transactions.filter((t) => t.id !== id) }
          : p
      )
    );

  const setPrice = (ticker: string, price: number) => {
    if (!current) return;
    const now: PriceNow = { ticker, price, updatedAt: new Date().toISOString() };
    setData((d) =>
      d.map((p) =>
        p.id === current.id
          ? { ...p, prices: upsert(p.prices, (x) => x.ticker === ticker, now) }
          : p
      )
    );
  };

  const setTrigger = (tick: string, tr: Partial<Trigger>) => {
    if (!current) return;
    const base: Trigger = {
      ticker: tick,
      ...current.triggers.find((t) => t.ticker === tick)
    } as Trigger;
    const next = { ...base, ...tr } as Trigger;
    setData((d) =>
      d.map((p) =>
        p.id === current.id
          ? { ...p, triggers: upsert(p.triggers, (x) => x.ticker === tick, next) }
          : p
      )
    );
  };

  const addDividend = (d1: Omit<DividendEntry, "id">) => {
    if (!current) return;
    const n: DividendEntry = { id: uid(), ...d1 };
    setData((d) =>
      d.map((p) =>
        p.id === current.id ? { ...p, dividends: [...p.dividends, n] } : p
      )
    );
  };

  const removeDividend = (id: string) =>
    current &&
    setData((d) =>
      d.map((p) =>
        p.id === current.id
          ? { ...p, dividends: p.dividends.filter((x) => x.id !== id) }
          : p
      )
    );

  // Import/Export
  const [csvText, setCsvText] = useState("");
  const importCSV = (text: string) => {
    if (!current) return;
    const txs = csvToTransactions(text);
    if (txs.length === 0)
      return alert("Nada importado. Verifique o cabeçalho: date,ticker,type,qty,price,fees");
    setData((d) =>
      d.map((p) =>
        p.id === current.id
          ? { ...p, transactions: [...p.transactions, ...txs] }
          : p
      )
    );
    setTab("Transações");
  };
  const exportJSON = () =>
    download("acoes-pai-portfolios.json", JSON.stringify(data, null, 2));

  // Cálculos
  const positions = useMemo(
    () => (current ? aggregatePositions(current) : []),
    [current]
  );

  const totals = useMemo(() => {
    const invested = positions.reduce((s, x) => s + x.invested, 0);
    const mkt = positions.reduce((s, x) => s + x.mktValue, 0);
    const pl = mkt - invested;
    const divs = positions.reduce((s, x) => s + x.divsTotal, 0);
    return {
      invested,
      mkt,
      pl,
      plPct: invested > 0 ? (pl / invested) * 100 : 0,
      divs
    };
  }, [positions]);

  const allocData = positions
    .filter((p) => p.qty > 0 && p.mktValue > 0)
    .map((p) => ({ name: p.ticker, value: Number(p.mktValue.toFixed(2)) }));

  const triggerSignals = positions.filter((p) => p.signal !== "HOLD");

  // Render
  return (
    <div className="min-h-screen w-full bg-gray-50">
      {/* Header */}
      <header className="sticky top-0 z-30 backdrop-blur bg-white/70 border-b border-gray-100">
        <div className="max-w-7xl mx-auto px-4 py-3 flex items-center gap-3">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-xl bg-gray-900 text-white grid place-items-center font-bold">
              PAI
            </div>
            <div>
              <div className="text-sm text-gray-500 leading-tight">Gestor de Portfólios</div>
              <div className="font-semibold">Ações PAI</div>
            </div>
          </div>
          <div className="ml-auto flex items-center gap-2">
            <select
              value={sel}
              onChange={(e) => setSel(e.target.value)}
              className="px-3 py-1.5 border rounded-lg text-sm"
            >
              {data.map((p) => (
                <option key={p.id} value={p.id}>
                  {p.name}
                </option>
              ))}
            </select>
            <button onClick={newPortfolio} className="px-3 py-1.5 rounded-lg border text-sm hover:bg-gray-50">
              Novo
            </button>
            <button onClick={renamePortfolio} className="px-3 py-1.5 rounded-lg border text-sm hover:bg-gray-50">
              Renomear
            </button>
            <button onClick={deletePortfolio} className="px-3 py-1.5 rounded-lg border text-sm hover:bg-gray-50">
              Apagar
            </button>
            <button onClick={exportJSON} className="px-3 py-1.5 rounded-lg border text-sm hover:bg-gray-50">
              Exportar
            </button>
          </div>
        </div>
      </header>

      {/* Conteúdo */}
      <main className="max-w-7xl mx-auto px-4 py-6">
        {current ? (
          <>
            <Tabs
              tabs={[
                "Visão Geral",
                "Transações",
                "Cotações & Gatilhos",
                "Dividendos",
                "Análises",
                "Importar CSV"
              ]}
              value={tab}
              onChange={setTab}
            />

            {/* ======= Visão Geral ======= */}
            {tab === "Visão Geral" && (
              <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
                <Card
                  title="Resumo"
                  right={
                    <Badge tone={totals.pl >= 0 ? "success" : "danger"}>
                      {totals.pl >= 0 ? "Valorização" : "Desvalorização"}
                    </Badge>
                  }
                >
                  <div className="grid grid-cols-2 gap-3 text-sm">
                    <div className="p-3 rounded-xl bg-gray-50">
                      <div className="text-gray-500">Investido</div>
                      <div className="text-lg font-semibold">
                        {CURRENCY(totals.invested, current.baseCurrency)}
                      </div>
                    </div>
                    <div className="p-3 rounded-xl bg-gray-50">
                      <div className="text-gray-500">Valor de Mercado</div>
                      <div className="text-lg font-semibold">
                        {CURRENCY(totals.mkt, current.baseCurrency)}
                      </div>
                    </div>
                    <div className="p-3 rounded-xl bg-gray-50">
                      <div className="text-gray-500">P/L não realizado</div>
                      <div
                        className={`text-lg font-semibold ${
                          totals.pl >= 0 ? "text-emerald-600" : "text-rose-600"
                        }`}
                      >
                        {CURRENCY(totals.pl, current.baseCurrency)} ({numberFmt(totals.plPct)}%)
                      </div>
                    </div>
                    <div className="p-3 rounded-xl bg-gray-50">
                      <div className="text-gray-500">Dividendos recebidos</div>
                      <div className="text-lg font-semibold">
                        {CURRENCY(totals.divs, current.baseCurrency)}
                      </div>
                    </div>
                  </div>
                </Card>

                <Card title="Alocação por Ticker">
                  <div className="h-56">
                    {allocData.length > 0 ? (
                      <ResponsiveContainer width="100%" height="100%">
                        <PieChart>
                          <Pie data={allocData} dataKey="value" nameKey="name" outerRadius={90}>
                            {allocData.map((_, index) => (
                              <Cell key={index} fill={COLORS[index % COLORS.length]} />
                            ))}
                          </Pie>
                          <Tooltip
                            formatter={(v: any) => CURRENCY(Number(v), current.baseCurrency)}
                          />
                          <Legend />
                        </PieChart>
                      </ResponsiveContainer>
                    ) : (
                      <div className="text-sm text-gray-500">Sem posições com valor de mercado.</div>
                    )}
                  </div>
                </Card>

                <Card title="Sinais (Gatilhos)">
                  {triggerSignals.length === 0 ? (
                    <div className="text-sm text-gray-500">Nenhum gatilho ativo no momento.</div>
                  ) : (
                    <ul className="space-y-2 text-sm">
                      {triggerSignals.map((p) => (
                        <li
                          key={p.ticker}
                          className="flex items-center justify-between p-2 rounded-lg bg-gray-50"
                        >
                          <div className="font-medium">{p.ticker}</div>
                          <div className="flex items-center gap-3">
                            <div>
                              Cotação:{" "}
                              <span className="font-medium">
                                {CURRENCY(p.lastPrice, current.baseCurrency)}
                              </span>
                            </div>
                            <Badge
                              tone={
                                p.signal === "BUY"
                                  ? "success"
                                  : p.signal === "SELL"
                                  ? "danger"
                                  : "warning"
                              }
                            >
                              {p.signal}
                            </Badge>
                          </div>
                        </li>
                      ))}
                    </ul>
                  )}
                </Card>

                <Card title="Posições" className="lg:col-span-3">
                  <div className="overflow-auto">
                    <table className="min-w-full text-sm">
                      <thead>
                        <tr className="text-left text-gray-500">
                          <th className="py-2 pr-2">Ticker</th>
                          <th className="py-2 pr-2">Qtde</th>
                          <th className="py-2 pr-2">Preço Médio</th>
                          <th className="py-2 pr-2">Cotação</th>
                          <th className="py-2 pr-2">Val. Mercado</th>
                          <th className="py-2 pr-2">P/L</th>
                          <th className="py-2 pr-2">P/L %</th>
                          <th className="py-2 pr-2">Divid. Totais</th>
                          <th className="py-2 pr-2">DY / Custo</th>
                          <th className="py-2 pr-2">Gatilho</th>
                        </tr>
                      </thead>
                      <tbody>
                        {positions.map((p) => (
                          <tr key={p.ticker} className="border-t">
                            <td className="py-2 pr-2 font-medium">{p.ticker}</td>
                            <td className="py-2 pr-2">{numberFmt(p.qty, 0)}</td>
                            <td className="py-2 pr-2">
                              {CURRENCY(p.avgPrice, current.baseCurrency)}
                            </td>
                            <td className="py-2 pr-2">
                              {CURRENCY(p.lastPrice, current.baseCurrency)}
                            </td>
                            <td className="py-2 pr-2">
                              {CURRENCY(p.mktValue, current.baseCurrency)}
                            </td>
                            <td
                              className={`py-2 pr-2 ${
                                p.pl >= 0 ? "text-emerald-600" : "text-rose-600"
                              }`}
                            >
                              {CURRENCY(p.pl, current.baseCurrency)}
                            </td>
                            <td
                              className={`py-2 pr-2 ${
                                p.plPct >= 0 ? "text-emerald-600" : "text-rose-600"
                              }`}
                            >
                              {numberFmt(p.plPct)}%
                            </td>
                            <td className="py-2 pr-2">
                              {CURRENCY(p.divsTotal, current.baseCurrency)}
                            </td>
                            <td className="py-2 pr-2">{numberFmt(p.divYieldOnCost * 100)}%</td>
                            <td className="py-2 pr-2">
                              {p.trigger ? (
                                <div className="flex flex-col">
                                  {p.trigger.buyPrice != null && (
                                    <span>
                                      Buy ≤ {CURRENCY(p.trigger.buyPrice, current.baseCurrency)}
                                    </span>
                                  )}
                                  {p.trigger.sellPrice != null && (
                                    <span>
                                      Sell ≥ {CURRENCY(p.trigger.sellPrice, current.baseCurrency)}
                                    </span>
                                  )}
                                  {p.trigger.trailingStopPct != null && (
                                    <span>Stop {p.trigger.trailingStopPct}%</span>
                                  )}
                                </div>
                              ) : (
                                <span className="text-gray-400">—</span>
                              )}
                            </td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                </Card>
              </div>
            )}

            {/* ======= Transações ======= */}
{tab === "Transações" && (
  <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
    <Card title="Nova Transação">
      <TxForm onSubmit={addTx} />
    </Card>

    <Card title="Transações (mais recentes)" className="lg:col-span-2">
      <div className="max-h-96 overflow-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-2 pr-2">Data</th>
              <th className="py-2 pr-2">Ticker</th>
              <th className="py-2 pr-2">Tipo</th>
              <th className="py-2 pr-2">Qtde</th>
              <th className="py-2 pr-2">Preço</th>
              <th className="py-2 pr-2">Taxas</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {[...current.transactions].reverse().map((t) => (
              <tr key={t.id} className="border-t">
                <td className="py-2 pr-2">{t.date}</td>
                <td className="py-2 pr-2 font-medium">{t.ticker}</td>
                <td className="py-2 pr-2">{t.type}</td>
                <td className="py-2 pr-2">{numberFmt(t.qty, 0)}</td>
                <td className="py-2 pr-2">{CURRENCY(t.price, current.baseCurrency)}</td>
                <td className="py-2 pr-2">{t.fees ? CURRENCY(t.fees, current.baseCurrency) : "—"}</td>
                <td className="py-2 pr-2 text-right">
                  <button
                    onClick={() => removeTx(t.id)}
                    className="px-2 py-1 text-xs rounded-md border hover:bg-gray-50"
                  >
                    Excluir
                  </button>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
    </Card>
  </div>
)}

{/* ======= Cotações & Gatilhos ======= */}
{tab === "Cotações & Gatilhos" && (
  <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
    <Card title="Cotações Atuais">
      <PriceForm positions={positions} onSetPrice={setPrice} currency={current.baseCurrency} />
    </Card>

    <Card title="Definir Gatilhos">
      <TriggerForm positions={positions} onSetTrigger={setTrigger} currency={current.baseCurrency} />
    </Card>

    <Card title="Sinais ao vivo">
      {triggerSignals.length === 0 ? (
        <div className="text-sm text-gray-500">Nenhum gatilho ativo.</div>
      ) : (
        <ul className="space-y-2 text-sm">
          {triggerSignals.map((p) => (
            <li key={p.ticker} className="flex items-center justify-between p-2 rounded-lg bg-gray-50">
              <div className="font-medium">{p.ticker}</div>
              <div className="flex items-center gap-3">
                <span className="text-gray-500">{CURRENCY(p.lastPrice, current.baseCurrency)}</span>
                <Badge
                  tone={
                    p.signal === "BUY" ? "success" :
                    p.signal === "SELL" ? "danger"  : "warning"
                  }
                >
                  {p.signal}
                </Badge>
              </div>
            </li>
          ))}
        </ul>
      )}
    </Card>
  </div>
)}

{/* ======= Dividendos ======= */}
{tab === "Dividendos" && (
  <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
    <Card title="Novo Lançamento">
      <DividendForm onSubmit={addDividend} />
    </Card>

    <Card title="Histórico de Dividendos" className="lg:col-span-2">
      <div className="overflow-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-2 pr-2">Data</th>
              <th className="py-2 pr-2">Ticker</th>
              <th className="py-2 pr-2">Tipo</th>
              <th className="py-2 pr-2">R$ / Ação</th>
              <th className="py-2 pr-2">Qtde na Data</th>
              <th className="py-2 pr-2">Total</th>
              <th></th>
            </tr>
          </thead>
          <tbody>
            {current.dividends
              .sort((a, b) => a.date.localeCompare(b.date))
              .map((d) => {
                const q = shareCountAtDate(current.transactions, d.ticker, d.date);
                const total = q * d.valuePerShare;
                return (
                  <tr key={d.id} className="border-t">
                    <td className="py-2 pr-2">{d.date}</td>
                    <td className="py-2 pr-2 font-medium">{d.ticker}</td>
                    <td className="py-2 pr-2">{d.type}</td>
                    <td className="py-2 pr-2">{CURRENCY(d.valuePerShare, current.baseCurrency)}</td>
                    <td className="py-2 pr-2">{numberFmt(q, 0)}</td>
                    <td className="py-2 pr-2">{CURRENCY(total, current.baseCurrency)}</td>
                    <td className="py-2 pr-2 text-right">
                      <button
                        onClick={() => removeDividend(d.id)}
                        className="px-2 py-1 text-xs rounded-md border hover:bg-gray-50"
                      >
                        Excluir
                      </button>
                    </td>
                  </tr>
                );
              })}
          </tbody>
        </table>
      </div>
    </Card>
  </div>
)}

{/* ======= Análises ======= */}
{tab === "Análises" && (
  <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
    <Card title="Top P/L (%)">
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={[...positions].sort((a, b) => b.plPct - a.plPct).slice(0, 8)}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="ticker" />
            <YAxis />
            <Tooltip formatter={(v: any, n: any) => (n === "plPct" ? `${numberFmt(Number(v))}%` : v)} />
            <Bar dataKey="plPct" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>

    <Card title="Dividendos por Ticker (R$)">
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <BarChart data={positions.map((p) => ({ ticker: p.ticker, divs: p.divsTotal }))}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="ticker" />
            <YAxis />
            <Tooltip formatter={(v: any) => CURRENCY(Number(v), current.baseCurrency)} />
            <Bar dataKey="divs" />
          </BarChart>
        </ResponsiveContainer>
      </div>
    </Card>

    <Card title="Evolução (manual)">
      <div className="h-64">
        <ResponsiveContainer width="100%" height="100%">
          <LineChart data={[...current.history].sort((a, b) => a.date.localeCompare(b.date))}>
            <CartesianGrid strokeDasharray="3 3" />
            <XAxis dataKey="date" />
            <YAxis />
            <Tooltip formatter={(v: any) => CURRENCY(Number(v), current.baseCurrency)} />
            <Line type="monotone" dataKey="totalValue" strokeWidth={2} />
            <Legend />
          </LineChart>
        </ResponsiveContainer>
      </div>
      <HistoryForm
        onAdd={(row) =>
          setData((d) =>
            d.map((p) => (p.id === current.id ? { ...p, history: [...p.history, row] } : p))
          )
        }
      />
    </Card>
  </div>
)}

{/* ======= Importar CSV ======= */}
{tab === "Importar CSV" && (
  <div className="grid grid-cols-1 gap-4">
    <Card title="Importe suas transações (CSV)">
      <div className="space-y-2 text-sm">
        <p>
          Formato:{" "}
          <code className="bg-gray-100 px-1 py-0.5 rounded">date,ticker,type,qty,price,fees</code>{" "}
          (type = BUY/SELL)
        </p>
        <textarea
          value={csvText}
          onChange={(e) => setCsvText(e.target.value)}
          className="w-full h-56 border rounded-lg p-2"
          placeholder={`Exemplo
2024-01-15,PETR4,BUY,100,34.5,1.2
2024-02-10,PETR4,SELL,50,40.2,1.1`}
        />
        <div className="flex gap-2">
          <button onClick={() => importCSV(csvText)} className="px-3 py-1.5 rounded-lg border hover:bg-gray-50">
            Importar
          </button>
          <button onClick={() => setCsvText("")} className="px-3 py-1.5 rounded-lg border hover:bg-gray-50">
            Limpar
          </button>
        </div>
      </div>
    </Card>
  </div>
)}

          </>
        ) : (
          <div className="text-sm text-gray-500">Nenhum portfólio. Crie um novo acima.</div>
        )}
      </main>
    </div>
  );
}
// ================================
// Formularios reutilizáveis
// ================================

type TxFormProps = { onSubmit: (tx: Omit<Transaction, "id">) => void };
const TxForm: React.FC<TxFormProps> = ({ onSubmit }) => {
  const [date, setDate] = useState(todayISO());
  const [ticker, setTicker] = useState("");
  const [type, setType] = useState<Transaction["type"]>("BUY");
  const [qty, setQty] = useState<number>(0);
  const [price, setPrice] = useState<number>(0);
  const [fees, setFees] = useState<number>(0);

  const submit = () => {
    if (!ticker || qty <= 0 || price <= 0) return alert("Preencha ticker, quantidade e preço.");
    onSubmit({ date, ticker: ticker.toUpperCase(), type, qty, price, fees });
    setTicker(""); setQty(0); setPrice(0); setFees(0);
  };

  return (
    <div className="space-y-2 text-sm">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-gray-500 mb-1">Data</div>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full border rounded-lg px-2 py-1.5" />
        </div>
        <div>
          <div className="text-gray-500 mb-1">Tipo</div>
          <select value={type} onChange={(e) => setType(e.target.value as any)} className="w-full border rounded-lg px-2 py-1.5">
            <option value="BUY">BUY</option>
            <option value="SELL">SELL</option>
          </select>
        </div>
      </div>
      <div className="grid grid-cols-3 gap-2">
        <div>
          <div className="text-gray-500 mb-1">Ticker</div>
          <input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="PETR4" className="w-full border rounded-lg px-2 py-1.5 uppercase" />
        </div>
        <div>
          <div className="text-gray-500 mb-1">Quantidade</div>
          <input type="number" value={qty} onChange={(e) => setQty(Number(e.target.value))} className="w-full border rounded-lg px-2 py-1.5" />
        </div>
        <div>
          <div className="text-gray-500 mb-1">Preço (R$)</div>
          <input type="number" step="0.01" value={price} onChange={(e) => setPrice(Number(e.target.value))} className="w-full border rounded-lg px-2 py-1.5" />
        </div>
      </div>
      <div>
        <div className="text-gray-500 mb-1">Taxas (R$)</div>
        <input type="number" step="0.01" value={fees} onChange={(e) => setFees(Number(e.target.value))} className="w-full border rounded-lg px-2 py-1.5" />
      </div>
      <div className="pt-2">
        <button onClick={submit} className="px-3 py-1.5 rounded-lg border hover:bg-gray-50">Adicionar</button>
      </div>
    </div>
  );
};

type PriceFormProps = {
  positions: Position[];
  onSetPrice: (ticker: string, price: number) => void;
  currency: string;
};
const PriceForm: React.FC<PriceFormProps> = ({ positions, onSetPrice, currency }) => {
  const [filter, setFilter] = useState("");
  const data = positions.filter((p) => p.ticker.toLowerCase().includes(filter.toLowerCase()));
  const [ticker, setTicker] = useState("");
  const [price, setPrice] = useState<number>(0);

  const submit = () => {
    if (!ticker || price <= 0) return alert("Informe ticker e preço.");
    onSetPrice(ticker.toUpperCase(), price);
    setTicker(""); setPrice(0);
  };

  return (
    <div className="space-y-2 text-sm">
      <div className="flex gap-2">
        <input
          value={filter}
          onChange={(e) => setFilter(e.target.value)}
          placeholder="Filtrar ticker..."
          className="flex-1 border rounded-lg px-2 py-1.5"
        />
      </div>

      <div className="max-h-64 overflow-auto">
        <table className="min-w-full text-sm">
          <thead>
            <tr className="text-left text-gray-500">
              <th className="py-2 pr-2">Ticker</th>
              <th className="py-2 pr-2">Cotação</th>
              <th className="py-2 pr-2">Médio</th>
              <th className="py-2 pr-2">Sinal</th>
            </tr>
          </thead>
          <tbody>
            {data.map((p) => (
              <tr key={p.ticker} className="border-t">
                <td className="py-2 pr-2 font-medium">{p.ticker}</td>
                <td className="py-2 pr-2">{CURRENCY(p.lastPrice, currency)}</td>
                <td className="py-2 pr-2">{CURRENCY(p.avgPrice, currency)}</td>
                <td className="py-2 pr-2">
                  <Badge tone={p.signal === "BUY" ? "success" : p.signal === "SELL" ? "danger" : p.signal === "STOP" ? "warning" : "neutral"}>
                    {p.signal}
                  </Badge>
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      <div className="grid grid-cols-3 gap-2">
        <input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="Ticker" className="border rounded-lg px-2 py-1.5 uppercase" />
        <input type="number" step="0.01" value={price} onChange={(e) => setPrice(Number(e.target.value))} placeholder="Preço" className="border rounded-lg px-2 py-1.5" />
        <button onClick={submit} className="px-3 py-1.5 rounded-lg border hover:bg-gray-50">Atualizar</button>
      </div>
    </div>
  );
};

type TriggerFormProps = {
  positions: Position[];
  onSetTrigger: (ticker: string, t: Partial<Trigger>) => void;
  currency: string;
};
const TriggerForm: React.FC<TriggerFormProps> = ({ positions, onSetTrigger }) => {
  const [sel, setSel] = useState(positions[0]?.ticker || "");
  const [buy, setBuy] = useState<number | "">("");
  const [sell, setSell] = useState<number | "">("");
  const [stop, setStop] = useState<number | "">("");
  const [note, setNote] = useState("");

  useEffect(() => { setSel(positions[0]?.ticker || ""); }, [positions.length]);

  const submit = () => {
    if (!sel) return;
    onSetTrigger(sel, {
      buyPrice: buy === "" ? undefined : Number(buy),
      sellPrice: sell === "" ? undefined : Number(sell),
      trailingStopPct: stop === "" ? undefined : Number(stop),
      note
    });
    setBuy(""); setSell(""); setStop(""); setNote("");
  };

  return (
    <div className="space-y-2 text-sm">
      <div className="grid grid-cols-2 gap-2">
        <select value={sel} onChange={(e) => setSel(e.target.value)} className="border rounded-lg px-2 py-1.5">
          {positions.map((p) => (
            <option key={p.ticker} value={p.ticker}>{p.ticker}</option>
          ))}
        </select>
        <input value={note} onChange={(e) => setNote(e.target.value)} placeholder="Observação (opcional)" className="border rounded-lg px-2 py-1.5" />
      </div>

      <div className="grid grid-cols-3 gap-2">
        <div>
          <div className="text-gray-500 mb-1">Buy ≤</div>
          <input
            type="number" step="0.01"
            value={buy as any}
            onChange={(e) => setBuy(e.target.value === "" ? "" : Number(e.target.value))}
            className="w-full border rounded-lg px-2 py-1.5"
          />
        </div>
        <div>
          <div className="text-gray-500 mb-1">Sell ≥</div>
          <input
            type="number" step="0.01"
            value={sell as any}
            onChange={(e) => setSell(e.target.value === "" ? "" : Number(e.target.value))}
            className="w-full border rounded-lg px-2 py-1.5"
          />
        </div>
        <div>
          <div className="text-gray-500 mb-1">Stop %</div>
          <input
            type="number" step="0.1"
            value={stop as any}
            onChange={(e) => setStop(e.target.value === "" ? "" : Number(e.target.value))}
            className="w-full border rounded-lg px-2 py-1.5"
          />
        </div>
      </div>

      <div className="pt-2">
        <button onClick={submit} className="px-3 py-1.5 rounded-lg border hover:bg-gray-50">Aplicar</button>
      </div>
    </div>
  );
};

type DividendFormProps = { onSubmit: (d: Omit<DividendEntry, "id">) => void };
const DividendForm: React.FC<DividendFormProps> = ({ onSubmit }) => {
  const [date, setDate] = useState(todayISO());
  const [ticker, setTicker] = useState("");
  const [type, setType] = useState<DividendEntry["type"]>("PN");
  const [vps, setVps] = useState<number>(0);
  const [note, setNote] = useState("");

  const submit = () => {
    if (!ticker || vps <= 0) return alert("Preencha ticker e valor por ação.");
    onSubmit({ date, ticker: ticker.toUpperCase(), type, valuePerShare: vps, note });
    setTicker(""); setVps(0); setNote("");
  };

  return (
    <div className="space-y-2 text-sm">
      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-gray-500 mb-1">Data</div>
          <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="w-full border rounded-lg px-2 py-1.5" />
        </div>
        <div>
          <div className="text-gray-500 mb-1">Tipo</div>
          <select value={type} onChange={(e) => setType(e.target.value as any)} className="w-full border rounded-lg px-2 py-1.5">
            <option>ON</option>
            <option>PN</option>
            <option>UNIT</option>
            <option>BDR</option>
            <option>ETF</option>
            <option>OUTRO</option>
          </select>
        </div>
      </div>

      <div className="grid grid-cols-2 gap-2">
        <div>
          <div className="text-gray-500 mb-1">Ticker</div>
          <input value={ticker} onChange={(e) => setTicker(e.target.value)} placeholder="ITUB4" className="w-full border rounded-lg px-2 py-1.5 uppercase" />
        </div>
        <div>
          <div className="text-gray-500 mb-1">R$ por ação</div>
          <input type="number" step="0.01" value={vps} onChange={(e) => setVps(Number(e.target.value))} className="w-full border rounded-lg px-2 py-1.5" />
        </div>
      </div>

      <div>
        <div className="text-gray-500 mb-1">Observação</div>
        <input value={note} onChange={(e) => setNote(e.target.value)} className="w-full border rounded-lg px-2 py-1.5" />
      </div>

      <div className="pt-2">
        <button onClick={submit} className="px-3 py-1.5 rounded-lg border hover:bg-gray-50">Adicionar</button>
      </div>
    </div>
  );
};

type HistoryFormProps = { onAdd: (row: { date: string; totalValue: number }) => void };
const HistoryForm: React.FC<HistoryFormProps> = ({ onAdd }) => {
  const [date, setDate] = useState(todayISO());
  const [value, setValue] = useState<number>(0);
  return (
    <div className="mt-3 text-sm">
      <div className="grid grid-cols-3 gap-2">
        <input type="date" value={date} onChange={(e) => setDate(e.target.value)} className="border rounded-lg px-2 py-1.5" />
        <input type="number" step="0.01" value={value} onChange={(e) => setValue(Number(e.target.value))} className="border rounded-lg px-2 py-1.5" placeholder="Valor total" />
        <button
          onClick={() => { if (value > 0) onAdd({ date, totalValue: value }); }}
          className="px-3 py-1.5 rounded-lg border hover:bg-gray-50"
        >
          Registrar
        </button>
      </div>
    </div>
  );
};
