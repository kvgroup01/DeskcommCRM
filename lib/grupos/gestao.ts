/**
 * Administração de grupo de WhatsApp pelo número conectado: criar, membros,
 * administradores, nome e descrição, travas, link de convite e sair.
 *
 * Fica ao lado de `servico.ts` (QUAL grupo entra na inbox) e não o toca: criar
 * um grupo não o liga na inbox, e sair de um grupo ligado o deixa órfão na
 * lista — o mesmo caminho que `listarGruposDoNumero` já mostra para desligar.
 *
 * ─── A régua de toda escrita: o que o WhatsApp confirmou ─────────────────────
 * O WhatsApp recusa em silêncio quem não é administrador do grupo, recusa
 * adicionar quem só aceita convite, e o WAHA já respondeu 200 para operação que
 * não aconteceu (issue melgarafael/DeskcommCRM#1428). Por isso nenhuma função
 * aqui devolve "feito" a partir do retorno da escrita: ela RELÊ o grupo e conta
 * o que mudou de fato. A auditoria grava essa contagem, não o pedido.
 *
 * A auditoria guarda contagens e o id do grupo, nunca o telefone de quem entrou
 * ou saiu: o participante de grupo que não é contato do CRM não tem caminho de
 * LGPD (ver a spec de grupos na inbox), e a trilha é append-only.
 */
import type { SupabaseClient } from "@supabase/supabase-js";
import { z } from "zod";

import { audit as auditReal } from "@/lib/audit";
import type { AuditAction } from "@/lib/audit/actions";
import { capabilitiesOf, getAdapter } from "@/lib/channels";
import { phoneLookupVariants } from "@/lib/channels/phone-variants";
import { resolveSessionRef, CHANNEL_SESSION_REF_COLUMNS, type ChannelSessionRef } from "@/lib/channels/session-ref";
import type {
  ChannelGroup,
  ChannelGroupAdmin,
  ChannelGroupDetails,
  ChannelProvider,
  GroupParticipantRole,
  GroupParticipantsAction,
} from "@/lib/channels/types";

export class GestaoDeGrupoError extends Error {
  constructor(
    public readonly code:
      | "sessao_nao_encontrada"
      | "canal_sem_gestao"
      /** O WhatsApp não aplicou nada do que foi pedido — quase sempre: o número não é admin. */
      | "nao_confirmado"
      /** Nenhum dos telefones informados tem WhatsApp. */
      | "sem_whatsapp",
  ) {
    super(code);
    this.name = "GestaoDeGrupoError";
  }
}

export const chatIdDeGrupo = z.string().regex(/^[\d-]+@g\.us$/);
const jidDePessoa = z.string().regex(/^\d+@(c\.us|s\.whatsapp\.net|lid)$/);

/** Teto por pedido. Adicionar dezenas de pessoas de uma vez é padrão de spam para o WhatsApp. */
export const TETO_DE_PARTICIPANTES = 50;

export interface ParticipanteDetalhado {
  id: string;
  role: GroupParticipantRole;
  /** E.164 com `+`, quando o JID é de telefone; `null` para `@lid` (número oculto). */
  phone: string | null;
  /** O contato do CRM que é esta pessoa, quando há. */
  contact: { id: string; name: string | null } | null;
}

export interface GrupoDetalhado extends Omit<ChannelGroupDetails, "participants"> {
  participants: ParticipanteDetalhado[];
}

export interface DepsDeGestao {
  lerSessao(org: string, sessionId: string): Promise<{
    sessionRef: string;
    admin: ChannelGroupAdmin | null;
    listGroups: (() => Promise<ChannelGroup[]>) | null;
  } | null>;
  /** Contatos do CRM por telefone (variantes E.164) ou por lid; chave = o valor que casou. */
  contatosConhecidos(
    org: string,
    busca: { phones: string[]; lids: string[] },
  ): Promise<Array<{ id: string; name: string | null; phone_number: string | null; wa_lid: string | null }>>;
  audit(entry: {
    action: AuditAction;
    organizationId: string;
    actorUserId: string;
    resourceId: string;
    requestId: string;
    metadata: Record<string, unknown>;
  }): Promise<void>;
}

interface Alvo {
  organizationId: string;
  channelSessionId: string;
  chatId: string;
}

interface Ator {
  actorUserId: string;
  requestId: string;
}

async function adminDaSessao(deps: DepsDeGestao, org: string, sessionId: string) {
  const s = await deps.lerSessao(org, sessionId);
  if (!s) throw new GestaoDeGrupoError("sessao_nao_encontrada");
  if (!s.admin) throw new GestaoDeGrupoError("canal_sem_gestao");
  return { sessionRef: s.sessionRef, admin: s.admin, listGroups: s.listGroups };
}

function telefoneDoJid(jid: string): string | null {
  if (!/@(c\.us|s\.whatsapp\.net)$/.test(jid)) return null;
  return `+${jid.split("@")[0]}`;
}

function lidDoJid(jid: string): string | null {
  return jid.endsWith("@lid") ? jid.slice(0, -"@lid".length) : null;
}

/** `@s.whatsapp.net` e `@c.us` são o mesmo endereço de telefone em engines diferentes. */
function mesmaPessoa(jid: string): string {
  return jid.replace(/@s\.whatsapp\.net$/, "@c.us");
}

async function detalhar(deps: DepsDeGestao, org: string, d: ChannelGroupDetails): Promise<GrupoDetalhado> {
  const phones = d.participants.flatMap((p) => {
    const tel = telefoneDoJid(p.id);
    return tel ? phoneLookupVariants(tel) : [];
  });
  const lids = d.participants.map((p) => lidDoJid(p.id)).filter((x): x is string => x !== null);
  const contatos = phones.length + lids.length > 0 ? await deps.contatosConhecidos(org, { phones, lids }) : [];
  return {
    ...d,
    participants: d.participants.map((p) => {
      const tel = telefoneDoJid(p.id);
      const lid = lidDoJid(p.id);
      const variantes = tel ? new Set(phoneLookupVariants(tel)) : null;
      const c = contatos.find(
        (x) => (lid !== null && x.wa_lid === lid) || (variantes !== null && x.phone_number !== null && variantes.has(x.phone_number)),
      );
      return { id: p.id, role: p.role, phone: tel, contact: c ? { id: c.id, name: c.name } : null };
    }),
  };
}

export async function lerGrupo(deps: DepsDeGestao, e: Alvo): Promise<GrupoDetalhado> {
  chatIdDeGrupo.parse(e.chatId);
  const s = await adminDaSessao(deps, e.organizationId, e.channelSessionId);
  return detalhar(deps, e.organizationId, await s.admin.getGroup({ sessionRef: s.sessionRef, chatId: e.chatId }));
}

/** Cada telefone vira o JID que o WhatsApp endereça; o que não tem WhatsApp volta à parte. */
async function resolverTelefones(admin: ChannelGroupAdmin, sessionRef: string, phones: string[]) {
  const resolvidos: Array<{ phone: string; id: string; aliases: string[] }> = [];
  const semWhatsapp: string[] = [];
  // Sequencial de propósito: é uma consulta ao WhatsApp por telefone, e rajada
  // de `check-exists` é o mesmo padrão que o anti-banimento evita no envio.
  for (const phone of phones) {
    const r = await admin.resolveParticipant({ sessionRef, phone });
    if (r) resolvidos.push({ phone, ...r });
    else semWhatsapp.push(phone);
  }
  return { resolvidos, semWhatsapp };
}

export async function criarGrupo(
  deps: DepsDeGestao,
  e: Omit<Alvo, "chatId"> & Ator & { subject: string; phones: string[] },
): Promise<{ chatId: string; adicionados: number; naoEntraram: string[]; semWhatsapp: string[] }> {
  const s = await adminDaSessao(deps, e.organizationId, e.channelSessionId);
  const { resolvidos, semWhatsapp } = await resolverTelefones(s.admin, s.sessionRef, e.phones);
  if (resolvidos.length === 0) throw new GestaoDeGrupoError("sem_whatsapp");

  const { chatId } = await s.admin.createGroup({
    sessionRef: s.sessionRef,
    subject: e.subject,
    participantIds: resolvidos.map((r) => r.id),
  });
  // O grupo nasce mesmo quando parte das pessoas não entra (privacidade "só
  // meus contatos" barra a adição). A releitura diz quem está lá.
  const depois = await s.admin.getGroup({ sessionRef: s.sessionRef, chatId });
  const presentes = new Set(depois.participants.map((p) => mesmaPessoa(p.id)));
  const naoEntraram = resolvidos.filter((r) => !r.aliases.some((a) => presentes.has(mesmaPessoa(a)))).map((r) => r.phone);

  await deps.audit({
    action: "channel.group_created",
    organizationId: e.organizationId,
    actorUserId: e.actorUserId,
    resourceId: e.channelSessionId,
    requestId: e.requestId,
    metadata: {
      channel_session_id: e.channelSessionId,
      group_chat_id: chatId,
      pedidos: e.phones.length,
      adicionados: resolvidos.length - naoEntraram.length,
      nao_entraram: naoEntraram.length,
      sem_whatsapp: semWhatsapp.length,
    },
  });
  return { chatId, adicionados: resolvidos.length - naoEntraram.length, naoEntraram, semWhatsapp };
}

/** A pós-condição de cada ação, lida na lista de participantes RELIDA. */
function aplicou(
  acao: GroupParticipantsAction,
  aliases: string[],
  porJid: Map<string, GroupParticipantRole>,
): boolean {
  const papel = aliases.map((a) => porJid.get(mesmaPessoa(a))).find((p) => p !== undefined);
  switch (acao) {
    case "add":
      return papel !== undefined;
    case "remove":
      return papel === undefined;
    case "promote":
      return papel === "admin" || papel === "superadmin";
    case "demote":
      return papel === "participant";
  }
}

export async function alterarParticipantes(
  deps: DepsDeGestao,
  e: Alvo & Ator & { action: GroupParticipantsAction } & (
    | { phones: string[]; participantIds?: undefined }
    | { participantIds: string[]; phones?: undefined }
  ),
): Promise<{ confirmados: string[]; naoAplicados: string[]; semWhatsapp: string[] }> {
  chatIdDeGrupo.parse(e.chatId);
  const s = await adminDaSessao(deps, e.organizationId, e.channelSessionId);

  // Adicionar parte de TELEFONE (quem ainda não está no grupo); as outras três
  // partem do JID que a própria lista de participantes mostrou.
  let alvos: Array<{ rotulo: string; id: string; aliases: string[] }>;
  let semWhatsapp: string[] = [];
  if (e.phones) {
    const r = await resolverTelefones(s.admin, s.sessionRef, e.phones);
    alvos = r.resolvidos.map((x) => ({ rotulo: x.phone, id: x.id, aliases: x.aliases }));
    semWhatsapp = r.semWhatsapp;
    if (alvos.length === 0) throw new GestaoDeGrupoError("sem_whatsapp");
  } else {
    alvos = e.participantIds.map((id) => ({ rotulo: jidDePessoa.parse(id), id, aliases: [id] }));
  }

  await s.admin.changeParticipants({
    sessionRef: s.sessionRef,
    chatId: e.chatId,
    action: e.action,
    participantIds: alvos.map((a) => a.id),
  });

  const depois = await s.admin.getGroup({ sessionRef: s.sessionRef, chatId: e.chatId });
  const porJid = new Map(depois.participants.map((p) => [mesmaPessoa(p.id), p.role]));
  const confirmados = alvos.filter((a) => aplicou(e.action, a.aliases, porJid)).map((a) => a.rotulo);
  const naoAplicados = alvos.filter((a) => !aplicou(e.action, a.aliases, porJid)).map((a) => a.rotulo);

  await deps.audit({
    action: "channel.group_participants_changed",
    organizationId: e.organizationId,
    actorUserId: e.actorUserId,
    resourceId: e.channelSessionId,
    requestId: e.requestId,
    metadata: {
      channel_session_id: e.channelSessionId,
      group_chat_id: e.chatId,
      acao: e.action,
      pedidos: alvos.length + semWhatsapp.length,
      confirmados: confirmados.length,
      nao_aplicados: naoAplicados.length,
      sem_whatsapp: semWhatsapp.length,
    },
  });
  if (confirmados.length === 0) throw new GestaoDeGrupoError("nao_confirmado");
  return { confirmados, naoAplicados, semWhatsapp };
}

type Campo = "subject" | "description" | "onlyAdminsSend" | "onlyAdminsEditInfo";

export async function atualizarDados(
  deps: DepsDeGestao,
  e: Alvo & Ator & {
    subject?: string;
    description?: string;
    onlyAdminsSend?: boolean;
    onlyAdminsEditInfo?: boolean;
  },
): Promise<{ grupo: GrupoDetalhado; naoAplicados: Campo[] }> {
  chatIdDeGrupo.parse(e.chatId);
  const s = await adminDaSessao(deps, e.organizationId, e.channelSessionId);
  const base = { sessionRef: s.sessionRef, chatId: e.chatId };
  if (e.subject !== undefined) await s.admin.setSubject({ ...base, subject: e.subject });
  if (e.description !== undefined) await s.admin.setDescription({ ...base, description: e.description });
  if (e.onlyAdminsSend !== undefined || e.onlyAdminsEditInfo !== undefined) {
    await s.admin.setSettings({ ...base, onlyAdminsSend: e.onlyAdminsSend, onlyAdminsEditInfo: e.onlyAdminsEditInfo });
  }

  const depois = await s.admin.getGroup(base);
  const pedidos = (["subject", "description", "onlyAdminsSend", "onlyAdminsEditInfo"] as const).filter((c) => e[c] !== undefined);
  // Campo que o WhatsApp não devolve na leitura (`null`) não dá para conferir;
  // ele não conta como recusado — conta como recusado só o que voltou DIFERENTE.
  const naoAplicados = pedidos.filter((c) => depois[c] !== null && depois[c] !== e[c]);

  await deps.audit({
    action: "channel.group_info_updated",
    organizationId: e.organizationId,
    actorUserId: e.actorUserId,
    resourceId: e.channelSessionId,
    requestId: e.requestId,
    metadata: { channel_session_id: e.channelSessionId, group_chat_id: e.chatId, campos: pedidos, nao_aplicados: naoAplicados },
  });
  if (pedidos.length > 0 && naoAplicados.length === pedidos.length) throw new GestaoDeGrupoError("nao_confirmado");
  return { grupo: await detalhar(deps, e.organizationId, depois), naoAplicados };
}

export async function linkDeConvite(deps: DepsDeGestao, e: Alvo): Promise<{ link: string }> {
  chatIdDeGrupo.parse(e.chatId);
  const s = await adminDaSessao(deps, e.organizationId, e.channelSessionId);
  return { link: await s.admin.getInviteLink({ sessionRef: s.sessionRef, chatId: e.chatId }) };
}

export async function revogarConvite(deps: DepsDeGestao, e: Alvo & Ator): Promise<{ link: string }> {
  chatIdDeGrupo.parse(e.chatId);
  const s = await adminDaSessao(deps, e.organizationId, e.channelSessionId);
  const antes = await s.admin.getInviteLink({ sessionRef: s.sessionRef, chatId: e.chatId });
  const link = await s.admin.revokeInviteLink({ sessionRef: s.sessionRef, chatId: e.chatId });
  // O link revogado que volta IGUAL não foi revogado — quem compartilhou o antigo continua entrando.
  if (link === antes) throw new GestaoDeGrupoError("nao_confirmado");
  await deps.audit({
    action: "channel.group_invite_revoked",
    organizationId: e.organizationId,
    actorUserId: e.actorUserId,
    resourceId: e.channelSessionId,
    requestId: e.requestId,
    metadata: { channel_session_id: e.channelSessionId, group_chat_id: e.chatId },
  });
  return { link };
}

export async function sairDoGrupo(deps: DepsDeGestao, e: Alvo & Ator): Promise<{ saiu: true }> {
  chatIdDeGrupo.parse(e.chatId);
  const s = await adminDaSessao(deps, e.organizationId, e.channelSessionId);
  await s.admin.leaveGroup({ sessionRef: s.sessionRef, chatId: e.chatId });
  // Pós-condição: o grupo saiu da lista do número. Sem lista para conferir, a
  // resposta do WAHA é o que há.
  if (s.listGroups) {
    const grupos = await s.listGroups();
    if (grupos.some((g) => g.chatId === e.chatId)) throw new GestaoDeGrupoError("nao_confirmado");
  }
  await deps.audit({
    action: "channel.group_left",
    organizationId: e.organizationId,
    actorUserId: e.actorUserId,
    resourceId: e.channelSessionId,
    requestId: e.requestId,
    metadata: { channel_session_id: e.channelSessionId, group_chat_id: e.chatId },
  });
  return { saiu: true };
}

/** Dependências reais. `admin` é service role: TODA consulta filtra `organization_id`. */
export function criarDepsDeGestao(admin: SupabaseClient): DepsDeGestao {
  return {
    async lerSessao(org, sessionId) {
      const { data } = await admin
        .from("channel_sessions")
        .select(`id, ${CHANNEL_SESSION_REF_COLUMNS}`)
        .eq("organization_id", org)
        .eq("id", sessionId)
        .maybeSingle();
      if (!data) return null;
      const ref = data as unknown as ChannelSessionRef & { provider: ChannelProvider };
      const adapter = getAdapter(ref.provider);
      const sessionRef = resolveSessionRef(ref);
      // Só canal com grupos `full` administra: `limited` lista, mas não é dono do grupo.
      const gerencia = capabilitiesOf(ref.provider).groups === "full" ? (adapter.groupAdmin ?? null) : null;
      return {
        sessionRef,
        admin: gerencia,
        listGroups: adapter.listGroups ? () => adapter.listGroups!({ sessionRef }) : null,
      };
    },
    async contatosConhecidos(org, busca) {
      const campos = "id, name, phone_number, wa_lid";
      const [porTelefone, porLid] = await Promise.all([
        busca.phones.length
          ? admin.from("contacts").select(campos).eq("organization_id", org).eq("is_anonymized", false).is("is_merged_into", null).in("phone_number", busca.phones)
          : Promise.resolve({ data: [] }),
        busca.lids.length
          ? admin.from("contacts").select(campos).eq("organization_id", org).eq("is_anonymized", false).is("is_merged_into", null).in("wa_lid", busca.lids)
          : Promise.resolve({ data: [] }),
      ]);
      type Linha = { id: string; name: string | null; phone_number: string | null; wa_lid: string | null };
      return [...((porTelefone.data ?? []) as Linha[]), ...((porLid.data ?? []) as Linha[])];
    },
    async audit(entry) {
      await auditReal({
        action: entry.action,
        organizationId: entry.organizationId,
        actorUserId: entry.actorUserId,
        resourceType: "channel_session",
        resourceId: entry.resourceId,
        requestId: entry.requestId,
        metadata: entry.metadata,
      });
    },
  };
}
