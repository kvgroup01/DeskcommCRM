import { beforeEach, describe, expect, it, vi } from "vitest";

import type { ChannelGroupAdmin, ChannelGroupDetails } from "@/lib/channels/types";

import {
  alterarParticipantes,
  atualizarDados,
  criarGrupo,
  type DepsDeGestao,
  GestaoDeGrupoError,
  lerGrupo,
  revogarConvite,
  sairDoGrupo,
} from "./gestao";

const ORG = "org-1";
const SESS = "sess-1";
const GRUPO = "120363000000000001@g.us";
const ator = { actorUserId: "u1", requestId: "r1" };
const alvo = { organizationId: ORG, channelSessionId: SESS, chatId: GRUPO };

function grupo(participants: ChannelGroupDetails["participants"], extra: Partial<ChannelGroupDetails> = {}): ChannelGroupDetails {
  return {
    chatId: GRUPO,
    subject: "Clientes",
    description: null,
    participants,
    onlyAdminsSend: false,
    onlyAdminsEditInfo: false,
    ...extra,
  };
}

let admin: { [K in keyof ChannelGroupAdmin]: ReturnType<typeof vi.fn> };
let deps: DepsDeGestao & { audit: ReturnType<typeof vi.fn>; contatosConhecidos: ReturnType<typeof vi.fn> };
let gruposDoNumero: Array<{ chatId: string; subject: string | null }>;

beforeEach(() => {
  admin = {
    getGroup: vi.fn(),
    createGroup: vi.fn(),
    changeParticipants: vi.fn(async () => undefined),
    setSubject: vi.fn(async () => undefined),
    setDescription: vi.fn(async () => undefined),
    setSettings: vi.fn(async () => undefined),
    getInviteLink: vi.fn(),
    revokeInviteLink: vi.fn(),
    leaveGroup: vi.fn(async () => undefined),
    resolveParticipant: vi.fn(),
  };
  gruposDoNumero = [];
  deps = {
    lerSessao: vi.fn(async () => ({
      sessionRef: "ref",
      admin: admin as unknown as ChannelGroupAdmin,
      listGroups: async () => gruposDoNumero,
    })),
    contatosConhecidos: vi.fn(async () => []),
    audit: vi.fn(async () => undefined),
  };
});

describe("sessão", () => {
  it("sessão de outra organização não existe", async () => {
    deps.lerSessao = vi.fn(async () => null);
    await expect(lerGrupo(deps, alvo)).rejects.toMatchObject({ code: "sessao_nao_encontrada" });
  });

  it("canal sem administração de grupo recusa antes de qualquer chamada", async () => {
    deps.lerSessao = vi.fn(async () => ({ sessionRef: "ref", admin: null, listGroups: null }));
    await expect(
      alterarParticipantes(deps, { ...alvo, ...ator, action: "add", phones: ["5531999990000"] }),
    ).rejects.toMatchObject({ code: "canal_sem_gestao" });
    expect(admin.changeParticipants).not.toHaveBeenCalled();
  });
});

describe("lerGrupo", () => {
  it("liga participante ao contato do CRM por telefone (com o nono dígito) e por lid", async () => {
    admin.getGroup.mockResolvedValue(
      grupo([
        { id: "553199990000@c.us", role: "superadmin" },
        { id: "98765@lid", role: "participant" },
        { id: "5511888880000@c.us", role: "admin" },
      ]),
    );
    deps.contatosConhecidos.mockResolvedValue([
      // gravado COM o nono; o WhatsApp listou SEM
      { id: "c1", name: "Ana", phone_number: "+5531999990000", wa_lid: null },
      { id: "c2", name: "Bia", phone_number: null, wa_lid: "98765" },
    ]);
    const g = await lerGrupo(deps, alvo);
    expect(deps.contatosConhecidos).toHaveBeenCalledWith(ORG, expect.objectContaining({ lids: ["98765"] }));
    expect(g.participants).toEqual([
      { id: "553199990000@c.us", role: "superadmin", phone: "+553199990000", contact: { id: "c1", name: "Ana" } },
      { id: "98765@lid", role: "participant", phone: null, contact: { id: "c2", name: "Bia" } },
      { id: "5511888880000@c.us", role: "admin", phone: "+5511888880000", contact: null },
    ]);
  });

  it("id de grupo inválido não chega ao WhatsApp", async () => {
    await expect(lerGrupo(deps, { ...alvo, chatId: "5531@c.us" })).rejects.toThrow();
    expect(admin.getGroup).not.toHaveBeenCalled();
  });
});

describe("criarGrupo", () => {
  it("cria só com quem tem WhatsApp e conta quem de fato entrou", async () => {
    admin.resolveParticipant.mockImplementation(async ({ phone }: { phone: string }) =>
      phone === "000" ? null : { id: `${phone}@c.us`, aliases: [`${phone}@c.us`, `lid-${phone}@lid`] },
    );
    admin.createGroup.mockResolvedValue({ chatId: GRUPO });
    // "222" tem privacidade que barra adição: o grupo nasce sem ele.
    // "111" aparece pelo lid — conta como dentro.
    admin.getGroup.mockResolvedValue(grupo([{ id: "lid-111@lid", role: "participant" }]));

    const r = await criarGrupo(deps, {
      organizationId: ORG,
      channelSessionId: SESS,
      ...ator,
      subject: "Clientes",
      phones: ["111", "222", "000"],
    });

    expect(admin.createGroup).toHaveBeenCalledWith({ sessionRef: "ref", subject: "Clientes", participantIds: ["111@c.us", "222@c.us"] });
    expect(r).toEqual({ chatId: GRUPO, adicionados: 1, naoEntraram: ["222"], semWhatsapp: ["000"] });
    const entrada = deps.audit.mock.calls[0]![0];
    expect(entrada).toMatchObject({ action: "channel.group_created", metadata: { adicionados: 1, nao_entraram: 1, sem_whatsapp: 1 } });
    // A trilha guarda contagem, nunca o telefone de quem entrou.
    const valores = Object.values(entrada.metadata as Record<string, unknown>).flat();
    for (const tel of ["111", "222", "000"]) expect(valores).not.toContain(tel);
  });

  it("ninguém com WhatsApp: não cria grupo nenhum", async () => {
    admin.resolveParticipant.mockResolvedValue(null);
    await expect(
      criarGrupo(deps, { organizationId: ORG, channelSessionId: SESS, ...ator, subject: "X", phones: ["1"] }),
    ).rejects.toMatchObject({ code: "sem_whatsapp" });
    expect(admin.createGroup).not.toHaveBeenCalled();
  });
});

describe("alterarParticipantes", () => {
  it("o WhatsApp responder OK sem aplicar vira nao_confirmado — e a tentativa fica na trilha", async () => {
    // Número conectado não é admin: o pedido "passa", e ninguém sai.
    admin.getGroup.mockResolvedValue(grupo([{ id: "5531999990000@c.us", role: "participant" }]));
    await expect(
      alterarParticipantes(deps, { ...alvo, ...ator, action: "remove", participantIds: ["5531999990000@c.us"] }),
    ).rejects.toBeInstanceOf(GestaoDeGrupoError);
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ metadata: expect.objectContaining({ confirmados: 0, nao_aplicados: 1 }) }));
  });

  it("promover: confirma pelo papel relido, e @s.whatsapp.net é o mesmo que @c.us", async () => {
    admin.getGroup.mockResolvedValue(
      grupo([
        { id: "5531999990000@s.whatsapp.net", role: "admin" },
        { id: "5531999991111@c.us", role: "participant" },
      ]),
    );
    const r = await alterarParticipantes(deps, {
      ...alvo,
      ...ator,
      action: "promote",
      participantIds: ["5531999990000@c.us", "5531999991111@c.us"],
    });
    expect(r).toEqual({ confirmados: ["5531999990000@c.us"], naoAplicados: ["5531999991111@c.us"], semWhatsapp: [] });
  });

  it("adicionar resolve o telefone antes, e só o resolvido vai ao WhatsApp", async () => {
    admin.resolveParticipant.mockImplementation(async ({ phone }: { phone: string }) =>
      phone === "5531999990000" ? { id: "5531999990000@c.us", aliases: ["5531999990000@c.us"] } : null,
    );
    admin.getGroup.mockResolvedValue(grupo([{ id: "5531999990000@c.us", role: "participant" }]));
    const r = await alterarParticipantes(deps, { ...alvo, ...ator, action: "add", phones: ["5531999990000", "5500000000000"] });
    expect(admin.changeParticipants).toHaveBeenCalledWith(expect.objectContaining({ action: "add", participantIds: ["5531999990000@c.us"] }));
    expect(r).toEqual({ confirmados: ["5531999990000"], naoAplicados: [], semWhatsapp: ["5500000000000"] });
  });

  it("JID que não é de pessoa é recusado antes do WhatsApp", async () => {
    await expect(
      alterarParticipantes(deps, { ...alvo, ...ator, action: "remove", participantIds: ["outro@g.us"] }),
    ).rejects.toThrow();
    expect(admin.changeParticipants).not.toHaveBeenCalled();
  });
});

describe("atualizarDados", () => {
  it("devolve o que voltou diferente; campo que o WhatsApp não lê não conta como recusado", async () => {
    admin.getGroup.mockResolvedValue(grupo([], { subject: "Novo", description: null, onlyAdminsSend: false }));
    const r = await atualizarDados(deps, { ...alvo, ...ator, subject: "Novo", description: "regras", onlyAdminsSend: true });
    expect(admin.setSettings).toHaveBeenCalledWith(expect.objectContaining({ onlyAdminsSend: true, onlyAdminsEditInfo: undefined }));
    expect(r.naoAplicados).toEqual(["onlyAdminsSend"]);
  });

  it("nada aplicado é nao_confirmado", async () => {
    admin.getGroup.mockResolvedValue(grupo([], { subject: "Antigo" }));
    await expect(atualizarDados(deps, { ...alvo, ...ator, subject: "Novo" })).rejects.toMatchObject({ code: "nao_confirmado" });
  });
});

describe("convite e saída", () => {
  it("revogar que devolve o MESMO link não revogou", async () => {
    admin.getInviteLink.mockResolvedValue("https://chat.whatsapp.com/A");
    admin.revokeInviteLink.mockResolvedValue("https://chat.whatsapp.com/A");
    await expect(revogarConvite(deps, { ...alvo, ...ator })).rejects.toMatchObject({ code: "nao_confirmado" });
    expect(deps.audit).not.toHaveBeenCalled();
  });

  it("revogar devolve o link novo e audita", async () => {
    admin.getInviteLink.mockResolvedValue("https://chat.whatsapp.com/A");
    admin.revokeInviteLink.mockResolvedValue("https://chat.whatsapp.com/B");
    await expect(revogarConvite(deps, { ...alvo, ...ator })).resolves.toEqual({ link: "https://chat.whatsapp.com/B" });
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "channel.group_invite_revoked" }));
  });

  it("sair só conta quando o grupo some da lista do número", async () => {
    gruposDoNumero = [{ chatId: GRUPO, subject: "Clientes" }];
    await expect(sairDoGrupo(deps, { ...alvo, ...ator })).rejects.toMatchObject({ code: "nao_confirmado" });
    gruposDoNumero = [];
    await expect(sairDoGrupo(deps, { ...alvo, ...ator })).resolves.toEqual({ saiu: true });
    expect(deps.audit).toHaveBeenCalledTimes(1);
    expect(deps.audit).toHaveBeenCalledWith(expect.objectContaining({ action: "channel.group_left" }));
  });
});
