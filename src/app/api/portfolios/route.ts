// src/app/api/portfolios/route.ts
import { NextRequest, NextResponse } from "next/server";

// Evita cache/ISR em App Router para esta rota
export const dynamic = "force-dynamic";
export const revalidate = 0;

const OWNER = process.env.GITHUB_OWNER!;
const REPO = process.env.GITHUB_REPO!;
const TOKEN = process.env.GITHUB_TOKEN!;
const BRANCH = process.env.GITHUB_BRANCH || "main";
const DATA_PATH = process.env.GITHUB_DATA_PATH || "data/portfolios.json";

type GHFileResp = {
  content: string; // base64 com quebras de linha
  sha: string;
};

// Verifica envs cedo, com mensagem útil
function assertEnvs() {
  const missing: string[] = [];
  if (!OWNER) missing.push("GITHUB_OWNER");
  if (!REPO) missing.push("GITHUB_REPO");
  if (!TOKEN) missing.push("GITHUB_TOKEN");
  if (!BRANCH) missing.push("GITHUB_BRANCH");
  if (!DATA_PATH) missing.push("GITHUB_DATA_PATH");
  if (missing.length) {
    throw new Error(`Env faltando: ${missing.join(", ")}`);
  }
}

async function githubGetFile(): Promise<{ json: any; sha: string | null }> {
  assertEnvs();
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(
    DATA_PATH
  )}?ref=${encodeURIComponent(BRANCH)}`;

  const r = await fetch(url, {
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      // Algumas instalações do GitHub esperam um User-Agent
      "User-Agent": "acoes-pai-portfolio-app"
    },
    cache: "no-store"
  });

  if (r.status === 404) {
    // arquivo ainda não existe; OK retornar vazio
    return { json: [], sha: null };
  }
  if (r.status === 401 || r.status === 403) {
    const t = await r.text();
    throw new Error(
      `Permissão negada na GitHub API (GET ${r.status}). Verifique GITHUB_TOKEN (escopo Contents: Read/Write) e se OWNER/REPO apontam para o repo correto. Detalhe: ${t}`
    );
  }
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`GET ${r.status}: ${t}`);
  }

  const data = (await r.json()) as GHFileResp;

  // O GitHub retorna base64 com quebras de linha. Remova antes de decodificar.
  const base64 = (data.content || "").replace(/\n/g, "");
  const buf = Buffer.from(base64, "base64").toString("utf-8");
  const json = buf ? JSON.parse(buf) : [];
  return { json, sha: data.sha };
}

async function githubPutFile(nextJson: any, prevSha: string | null) {
  assertEnvs();
  const url = `https://api.github.com/repos/${OWNER}/${REPO}/contents/${encodeURIComponent(
    DATA_PATH
  )}`;

  const contentBase64 = Buffer.from(JSON.stringify(nextJson, null, 2), "utf-8").toString("base64");

  const body: any = {
    message: "chore(data): update portfolios.json via app",
    content: contentBase64,
    branch: BRANCH
  };
  if (prevSha) body.sha = prevSha;

  const r = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bearer ${TOKEN}`,
      Accept: "application/vnd.github+json",
      "Content-Type": "application/json",
      "User-Agent": "acoes-pai-portfolio-app"
    },
    body: JSON.stringify(body)
  });

  if (r.status === 401 || r.status === 403) {
    const t = await r.text();
    throw new Error(
      `Permissão negada na GitHub API (PUT ${r.status}). O token precisa de Contents: Read/Write neste repo/branch. Detalhe: ${t}`
    );
  }
  if (r.status === 409) {
    const t = await r.text();
    throw new Error(
      `409 (conflict) ao salvar. O arquivo foi alterado por outra operação. Faça um GET (recarregar a página) e tente novamente. Detalhe: ${t}`
    );
  }
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`PUT ${r.status}: ${t}`);
  }
  return r.json();
}

// GET -> retorna o JSON
export async function GET() {
  try {
    const { json } = await githubGetFile();
    return NextResponse.json({ ok: true, data: json });
  } catch (e: any) {
    // Mantém a API falando a mesma "língua"
    return NextResponse.json({ ok: false, error: e.message }, { status: 500 });
  }
}

// PUT -> recebe { data: [...] } e salva no GitHub
export async function PUT(req: NextRequest) {
  try {
    const body = await req.json();
    if (!("data" in body)) {
      return NextResponse.json({ ok: false, error: "Missing 'data' field" }, { status: 400 });
    }
    const { sha } = await githubGetFile();
    await githubPutFile(body.data, sha);
    return NextResponse.json({ ok: true });
  } catch (e: any) {
    const msg = e?.message || "Unknown error";
    const status =
      msg.includes("409 (conflict)") ? 409 :
      msg.includes("Permissão negada") ? 403 : 500;
    return NextResponse.json({ ok: false, error: msg }, { status });
  }
}
