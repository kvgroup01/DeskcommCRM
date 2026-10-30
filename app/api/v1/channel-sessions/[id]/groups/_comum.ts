/**
 * O que as rotas de administração de grupo têm em comum: quem pode, como o grupo
 * chega pelo caminho e o que responder quando algo dá errado. Compartilhado por
 * `groups/route.ts` (criar) e pelas rotas sob `groups/[groupId]/`.
 */
import { randomUUID } from "node:crypto";

import { z } from "zod";

import { fail } from "@/lib/api/wrappers";
import { requireRole } from "@/lib/auth/require-role";
import { criarDepsDeGestao, GestaoDeGrupoError, type DepsDeGestao } from "@/lib/grupos/gestao";
import { logger } from "@/lib/logger";
import { createAdminClient } from "@/lib/supabase/admin";

export const idDaSessao = z.string().uuid();

/**
 * O grupo vai no caminho SEM o `@g.us` (`/groups/1203630…/participants`): o `@`
 * codificado no caminho é a forma mais fácil de um proxy reescrever a URL.
 */
export const idDoGrupo = z.string().regex(/^[\d-]+$/).transform((d) => `${d}@g.us`);

/** Telefone como a equipe digita: com ou sem `+`, espaço, traço e parênteses. */
export const telefoneDigitado = z
  .string()
  .transform((t) => t.replace(/\D/g, ""))
  .pipe(z.string().min(10).max(15));

const RESPOSTA: Record<GestaoDeGrupoError["code"], { status: number; message: string }> = {
  sessao_nao_encontrada: { status: 404, message: "Conexão não encontrada." },
  canal_sem_gestao: { status: 409, message: "Esta conexão não administra grupos." },
  nao_confirmado: {
    status: 502,
    message: "O WhatsApp não aplicou a mudança. O número conectado precisa ser administrador do grupo.",
  },
  sem_whatsapp: { status: 422, message: "Nenhum dos telefones informados tem WhatsApp." },
};

export function falhaDeGestao(err: unknown, requestId: string): Response {
  if (err instanceof GestaoDeGrupoError) {
    const r = RESPOSTA[err.code];
    return fail(err.code, r.message, r.status, { requestId });
  }
  if (err instanceof z.ZodError) return fail("validation_error", "dados inválidos", 400, { requestId });
  // O resto é o transporte: sessão fora de WORKING, WAHA fora do ar, ou o
  // WhatsApp recusando com erro (não-admin em alguns engines vem como 4xx/5xx).
  logger.warn("grupos: a administração do grupo não passou pelo WhatsApp", {
    requestId,
    causa: err instanceof Error ? err.message : String(err),
  });
  return fail(
    "channel_unavailable",
    "O WhatsApp deste número não aceitou o pedido. Confira se ele está conectado e se é administrador do grupo.",
    502,
    { requestId },
  );
}

export type ContextoDoGrupo = { params: Promise<{ id: string; groupId: string }> };

/**
 * Gerente ou administrador, como a lista de grupos. A organização vem da sessão
 * autenticada, nunca do body. A guarda de suporte NÃO mora aqui: o gate
 * `tests/unit/suporte-cobertura-de-efeitos.test.ts` lê o texto de cada handler,
 * então quem escreve chama `requireSupportWrite()` no próprio handler, antes disto.
 */
export async function prepararPedidoDeGrupo(
  ctx: ContextoDoGrupo,
): Promise<
  | { ok: false; response: Response }
  | {
      ok: true;
      requestId: string;
      deps: DepsDeGestao;
      alvo: { organizationId: string; channelSessionId: string; chatId: string };
      ator: { actorUserId: string; requestId: string };
    }
> {
  const requestId = randomUUID();
  const authz = await requireRole("manager", { requestId, resource: "channel_session_groups" });
  if (!authz.ok) return { ok: false, response: authz.response };
  const params = await ctx.params;
  const sessao = idDaSessao.safeParse(params.id);
  const grupo = idDoGrupo.safeParse(params.groupId);
  if (!sessao.success || !grupo.success) {
    return { ok: false, response: fail("validation_error", "id inválido", 400, { requestId }) };
  }
  return {
    ok: true,
    requestId,
    deps: criarDepsDeGestao(createAdminClient()),
    alvo: { organizationId: authz.org.orgId, channelSessionId: sessao.data, chatId: grupo.data },
    ator: { actorUserId: authz.user.id, requestId },
  };
}
