import { NextRequest } from "next/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/lib/impersonate/support", () => ({ requireSupportWrite: vi.fn(async () => null) }));
vi.mock("@/lib/auth/require-role", () => ({ requireRole: vi.fn() }));
vi.mock("@/lib/supabase/admin", () => ({ createAdminClient: vi.fn(() => ({})) }));
vi.mock("@/lib/grupos/gestao", async (orig) => ({
  ...(await orig<typeof import("@/lib/grupos/gestao")>()),
  criarDepsDeGestao: vi.fn(() => ({})),
  lerGrupo: vi.fn(),
  atualizarDados: vi.fn(),
  alterarParticipantes: vi.fn(),
  sairDoGrupo: vi.fn(),
}));

import { requireRole } from "@/lib/auth/require-role";
import { requireSupportWrite } from "@/lib/impersonate/support";
import {
  alterarParticipantes,
  atualizarDados,
  GestaoDeGrupoError,
  lerGrupo,
  sairDoGrupo,
} from "@/lib/grupos/gestao";

import { POST as sair } from "./leave/route";
import { POST as participantes } from "./participants/route";
import { GET, PATCH } from "./route";

const ORG = "11111111-1111-4111-8111-111111111111";
const SESS = "22222222-2222-4222-8222-222222222222";
const ctx = (groupId = "120363000000000001") => ({
  params: Promise.resolve({ id: SESS, groupId }),
});
const autorizado = () =>
  vi
    .mocked(requireRole)
    .mockResolvedValue({
      ok: true,
      user: { id: "u1" },
      org: { orgId: ORG, role: "manager" },
    } as never);
const corpo = (b: unknown, method = "POST") =>
  new NextRequest("http://x", { method, body: JSON.stringify(b) });

beforeEach(() => vi.clearAllMocks());

describe("administração de um grupo", () => {
  it("atendente não administra grupo (a rota exige gerente)", async () => {
    vi.mocked(requireRole).mockResolvedValue({
      ok: false,
      response: new Response(null, { status: 403 }),
    } as never);
    const res = await participantes(
      corpo({ action: "remove", participant_ids: ["5531999990000@c.us"] }),
      ctx(),
    );
    expect(res.status).toBe(403);
    expect(requireRole).toHaveBeenCalledWith("manager", expect.anything());
    expect(alterarParticipantes).not.toHaveBeenCalled();
  });

  it("suporte em modo leitura é barrado antes do efeito", async () => {
    vi.mocked(requireSupportWrite).mockResolvedValueOnce(
      new Response(null, { status: 403 }) as never,
    );
    const res = await sair(new NextRequest("http://x", { method: "POST" }), ctx());
    expect(res.status).toBe(403);
    expect(sairDoGrupo).not.toHaveBeenCalled();
  });

  it("o grupo vem do caminho sem @g.us; a organização vem da sessão, nunca do body", async () => {
    autorizado();
    vi.mocked(lerGrupo).mockResolvedValue({} as never);
    const res = await GET(new NextRequest("http://x"), ctx());
    expect(res.status).toBe(200);
    expect(lerGrupo).toHaveBeenCalledWith(expect.anything(), {
      organizationId: ORG,
      channelSessionId: SESS,
      chatId: "120363000000000001@g.us",
    });
  });

  it("id de grupo que não é número é 400", async () => {
    autorizado();
    const res = await GET(new NextRequest("http://x"), ctx("abc@c.us"));
    expect(res.status).toBe(400);
  });

  it("adicionar normaliza o telefone digitado", async () => {
    autorizado();
    vi.mocked(alterarParticipantes).mockResolvedValue({
      confirmados: ["5531999990000"],
      naoAplicados: [],
      semWhatsapp: [],
    });
    const res = await participantes(
      corpo({ action: "add", phones: ["+55 (31) 99999-0000"], organization_id: "outra" }),
      ctx(),
    );
    expect(res.status).toBe(200);
    expect(alterarParticipantes).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        organizationId: ORG,
        action: "add",
        phones: ["5531999990000"],
        actorUserId: "u1",
      }),
    );
  });

  it("remover exige JID de pessoa, não telefone solto", async () => {
    autorizado();
    const res = await participantes(corpo({ action: "remove", phones: ["5531999990000"] }), ctx());
    expect(res.status).toBe(400);
  });

  it("WhatsApp que não aplicou vira 502 com a explicação de admin", async () => {
    autorizado();
    vi.mocked(alterarParticipantes).mockRejectedValue(new GestaoDeGrupoError("nao_confirmado"));
    const res = await participantes(
      corpo({ action: "promote", participant_ids: ["5531999990000@c.us"] }),
      ctx(),
    );
    expect(res.status).toBe(502);
    const j = (await res.json()) as { error: { code: string; message: string } };
    expect(j.error.code).toBe("nao_confirmado");
    expect(j.error.message).toMatch(/administrador/);
  });

  it("PATCH vazio é 400; PATCH com campo chega ao serviço em camelCase", async () => {
    autorizado();
    expect((await PATCH(corpo({}, "PATCH"), ctx())).status).toBe(400);
    vi.mocked(atualizarDados).mockResolvedValue({ grupo: {} as never, naoAplicados: [] });
    const res = await PATCH(corpo({ only_admins_send: true }, "PATCH"), ctx());
    expect(res.status).toBe(200);
    expect(atualizarDados).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ onlyAdminsSend: true }),
    );
  });

  it("transporte fora do ar é 502 com envelope, não 500 cru", async () => {
    autorizado();
    vi.mocked(sairDoGrupo).mockRejectedValue(new Error("waha_timeout"));
    const res = await sair(new NextRequest("http://x", { method: "POST" }), ctx());
    expect(res.status).toBe(502);
    expect(((await res.json()) as { error: { code: string } }).error.code).toBe(
      "channel_unavailable",
    );
  });
});
