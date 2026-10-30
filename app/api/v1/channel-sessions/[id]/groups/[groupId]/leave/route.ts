/**
 * POST /api/v1/channel-sessions/[id]/groups/[groupId]/leave — o número conectado sai do grupo.
 *
 * Não desfaz pelo CRM: voltar exige um convite de quem ficou. Se o grupo estava
 * ligado na inbox, ele passa a aparecer como órfão em Conexões › Grupos, onde a
 * chave pode ser desligada. Só gerente ou administrador.
 */
import type { NextRequest } from "next/server";

import { ok } from "@/lib/api/wrappers";
import { sairDoGrupo } from "@/lib/grupos/gestao";
import { requireSupportWrite } from "@/lib/impersonate/support";

import { falhaDeGestao, prepararPedidoDeGrupo, type ContextoDoGrupo } from "../../_comum";

export const dynamic = "force-dynamic";

export async function POST(_req: NextRequest, ctx: ContextoDoGrupo): Promise<Response> {
  const supportDenied = await requireSupportWrite();
  if (supportDenied) return supportDenied;
  const p = await prepararPedidoDeGrupo(ctx);
  if (!p.ok) return p.response;
  try {
    return ok(await sairDoGrupo(p.deps, { ...p.alvo, ...p.ator }), { requestId: p.requestId });
  } catch (err) {
    return falhaDeGestao(err, p.requestId);
  }
}
