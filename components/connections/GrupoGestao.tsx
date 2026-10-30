"use client";
/**
 * Conexões › Grupos › Gerenciar / Criar grupo: administrar o grupo pelo número
 * conectado. Monta dentro da mesma folha de `GruposSheet` (que já está atrás de
 * gerente+); as rotas exigem o mesmo papel no servidor.
 *
 * Toda escrita mostra o que o WhatsApp CONFIRMOU, não o que foi pedido: o
 * servidor relê o grupo depois de cada mudança (`lib/grupos/gestao.ts`) e a
 * tela repete essa contagem — "2 adicionados, 1 não entrou" —, porque o
 * WhatsApp recusa em silêncio quem não é administrador e quem só aceita convite.
 */
import { useCallback, useEffect, useMemo, useState } from "react";

import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Switch } from "@/components/ui/switch";
import { Textarea } from "@/components/ui/textarea";
import { useT } from "@/hooks/i18n/useT";

type Papel = "superadmin" | "admin" | "participant";

interface Participante {
  id: string;
  role: Papel;
  phone: string | null;
  contact: { id: string; name: string | null } | null;
}

interface Detalhe {
  chatId: string;
  subject: string | null;
  description: string | null;
  participants: Participante[];
  onlyAdminsSend: boolean | null;
  onlyAdminsEditInfo: boolean | null;
}

interface Resultado {
  confirmados: string[];
  naoAplicados: string[];
  semWhatsapp: string[];
}

/** O id do grupo vai no caminho sem o `@g.us` (ver `groups/_comum.ts`). */
function caminhoDoGrupo(channelId: string, chatId: string, resto = ""): string {
  return `/api/v1/channel-sessions/${channelId}/groups/${chatId.replace(/@g\.us$/, "")}${resto}`;
}

/** Um telefone por linha, ou separados por vírgula/ponto e vírgula. */
function telefonesDoTexto(texto: string): string[] {
  return texto
    .split(/[\n,;]+/)
    .map((t) => t.trim())
    .filter((t) => t.replace(/\D/g, "").length > 0);
}

async function mensagemDeErro(res: Response, padrao: string): Promise<string> {
  const j = (await res.json().catch(() => null)) as { error?: { message?: string } } | null;
  return j?.error?.message ?? padrao;
}

export function GrupoGestao({
  channelId,
  chatId,
  avisoInicial = null,
  onVoltar,
}: {
  channelId: string;
  chatId: string;
  /** O resumo da criação, quando a tela abre logo depois de criar o grupo. */
  avisoInicial?: string | null;
  onVoltar: (mudouLista: boolean) => void;
}) {
  const t = useT();
  const [grupo, setGrupo] = useState<Detalhe | null>(null);
  const [erro, setErro] = useState<string | null>(null);
  const [aviso, setAviso] = useState<string | null>(avisoInicial);
  const [ocupado, setOcupado] = useState(false);
  const [nome, setNome] = useState("");
  const [descricao, setDescricao] = useState("");
  const [novos, setNovos] = useState("");
  const [link, setLink] = useState<string | null>(null);
  const [confirmarSaida, setConfirmarSaida] = useState(false);
  const [confirmarRemocao, setConfirmarRemocao] = useState<Participante | null>(null);

  const carregar = useCallback(async () => {
    const res = await fetch(caminhoDoGrupo(channelId, chatId));
    const j = (await res.json().catch(() => null)) as { data?: Detalhe } | null;
    if (!res.ok || !j?.data) {
      setErro(t("Não consegui ler este grupo. Confira se o número está conectado."));
      return;
    }
    setGrupo(j.data);
    setNome(j.data.subject ?? "");
    setDescricao(j.data.description ?? "");
  }, [channelId, chatId, t]);

  useEffect(() => {
    void carregar();
  }, [carregar]);

  /** Corre uma escrita: limpa avisos, trava os botões, mostra o erro do servidor. */
  async function escrever(
    fazer: () => Promise<Response>,
    aoDarCerto: (res: Response) => Promise<void>,
  ) {
    setOcupado(true);
    setErro(null);
    setAviso(null);
    try {
      const res = await fazer();
      if (!res.ok) {
        setErro(t(await mensagemDeErro(res, "Não foi possível salvar.")));
        return;
      }
      await aoDarCerto(res);
    } finally {
      setOcupado(false);
    }
  }

  function contarResultado(r: Resultado, acao: "add" | "remove" | "promote" | "demote") {
    const feito = {
      add: t("adicionados"),
      remove: t("removidos"),
      promote: t("agora são administradores"),
      demote: t("deixaram de ser administradores"),
    }[acao];
    const partes = [`${r.confirmados.length} ${feito}.`];
    if (r.naoAplicados.length) {
      partes.push(
        `${r.naoAplicados.length} ${t("o WhatsApp não aplicou")}` +
          (acao === "add"
            ? ` (${t("a privacidade da pessoa só aceita convite — mande o link")}).`
            : "."),
      );
    }
    if (r.semWhatsapp.length) partes.push(`${t("Sem WhatsApp")}: ${r.semWhatsapp.join(", ")}.`);
    setAviso(partes.join(" "));
  }

  function alterar(
    acao: "add" | "remove" | "promote" | "demote",
    alvo: { phones?: string[]; participant_ids?: string[] },
  ) {
    return escrever(
      () =>
        fetch(caminhoDoGrupo(channelId, chatId, "/participants"), {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ action: acao, ...alvo }),
        }),
      async (res) => {
        const j = (await res.json()) as { data: Resultado };
        if (acao === "add") setNovos("");
        await carregar();
        contarResultado(j.data, acao);
      },
    );
  }

  function salvarDados(mudanca: Record<string, string | boolean>) {
    return escrever(
      () =>
        fetch(caminhoDoGrupo(channelId, chatId), {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(mudanca),
        }),
      async (res) => {
        const j = (await res.json()) as { data: { grupo: Detalhe; naoAplicados: string[] } };
        setGrupo(j.data.grupo);
        setAviso(
          j.data.naoAplicados.length
            ? t(
                "Parte da mudança não foi aplicada pelo WhatsApp. O número precisa ser administrador do grupo.",
              )
            : t("Salvo no WhatsApp."),
        );
      },
    );
  }

  const ordenados = useMemo(() => {
    const peso: Record<Papel, number> = { superadmin: 0, admin: 1, participant: 2 };
    return [...(grupo?.participants ?? [])].sort((a, b) => peso[a.role] - peso[b.role]);
  }, [grupo]);

  function rotulo(p: Participante): string {
    return p.contact?.name ?? p.phone ?? t("Número oculto pelo WhatsApp");
  }

  const nomeMudou = grupo !== null && nome.trim() !== "" && nome.trim() !== (grupo.subject ?? "");
  const descricaoMudou = grupo !== null && descricao !== (grupo.description ?? "");

  return (
    <div className="flex min-h-0 flex-1 flex-col gap-3 pt-3">
      <div>
        <Button variant="ghost" size="sm" onClick={() => onVoltar(false)}>
          ← {t("Voltar aos grupos")}
        </Button>
      </div>

      {erro && (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      )}
      {aviso && (
        <p role="status" className="text-sm text-muted-foreground">
          {aviso}
        </p>
      )}

      {!grupo && !erro && <p className="text-sm text-muted-foreground">{t("Carregando…")}</p>}

      {grupo && (
        <div className="min-h-0 flex-1 space-y-5 overflow-y-auto pr-1">
          <section className="space-y-2">
            <Label htmlFor="grupo-nome">{t("Nome do grupo")}</Label>
            <div className="flex gap-2">
              <Input
                id="grupo-nome"
                value={nome}
                maxLength={100}
                onChange={(e) => setNome(e.target.value)}
              />
              <Button
                size="sm"
                disabled={!nomeMudou || ocupado}
                onClick={() => void salvarDados({ subject: nome.trim() })}
              >
                {t("Salvar")}
              </Button>
            </div>
            <Label htmlFor="grupo-descricao">{t("Descrição")}</Label>
            <Textarea
              id="grupo-descricao"
              value={descricao}
              maxLength={2048}
              rows={3}
              onChange={(e) => setDescricao(e.target.value)}
            />
            <Button
              size="sm"
              variant="outline"
              disabled={!descricaoMudou || ocupado}
              onClick={() => void salvarDados({ description: descricao })}
            >
              {t("Salvar descrição")}
            </Button>
          </section>

          <section className="space-y-2">
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="grupo-so-admins-enviam">
                {t("Só administradores enviam mensagens")}
              </Label>
              <Switch
                id="grupo-so-admins-enviam"
                checked={grupo.onlyAdminsSend ?? false}
                disabled={ocupado}
                onCheckedChange={(v) => void salvarDados({ only_admins_send: v })}
              />
            </div>
            <div className="flex items-center justify-between gap-3">
              <Label htmlFor="grupo-so-admins-editam">
                {t("Só administradores editam os dados do grupo")}
              </Label>
              <Switch
                id="grupo-so-admins-editam"
                checked={grupo.onlyAdminsEditInfo ?? false}
                disabled={ocupado}
                onCheckedChange={(v) => void salvarDados({ only_admins_edit_info: v })}
              />
            </div>
          </section>

          <section className="space-y-2">
            <p className="text-sm font-medium">{t("Link de convite")}</p>
            {link ? (
              <div className="flex gap-2">
                <Input readOnly value={link} aria-label={t("Link de convite")} />
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => void navigator.clipboard?.writeText(link)}
                >
                  {t("Copiar")}
                </Button>
              </div>
            ) : null}
            <div className="flex gap-2">
              {!link && (
                <Button
                  size="sm"
                  variant="outline"
                  disabled={ocupado}
                  onClick={() =>
                    void escrever(
                      () => fetch(caminhoDoGrupo(channelId, chatId, "/invite")),
                      async (res) =>
                        setLink(((await res.json()) as { data: { link: string } }).data.link),
                    )
                  }
                >
                  {t("Mostrar link")}
                </Button>
              )}
              <Button
                size="sm"
                variant="outline"
                disabled={ocupado}
                onClick={() =>
                  void escrever(
                    () => fetch(caminhoDoGrupo(channelId, chatId, "/invite"), { method: "DELETE" }),
                    async (res) => {
                      setLink(((await res.json()) as { data: { link: string } }).data.link);
                      setAviso(t("Link antigo revogado. Quem tinha o anterior não entra mais."));
                    },
                  )
                }
              >
                {t("Revogar e gerar novo link")}
              </Button>
            </div>
          </section>

          <section className="space-y-2">
            <Label htmlFor="grupo-novos">{t("Adicionar participantes")}</Label>
            <Textarea
              id="grupo-novos"
              rows={3}
              value={novos}
              placeholder={t("Um telefone por linha, com DDD. Ex.: 31 99999-0000")}
              onChange={(e) => setNovos(e.target.value)}
            />
            <Button
              size="sm"
              disabled={ocupado || telefonesDoTexto(novos).length === 0}
              onClick={() => void alterar("add", { phones: telefonesDoTexto(novos) })}
            >
              {t("Adicionar")}
            </Button>
          </section>

          <section className="space-y-2">
            <p className="text-sm font-medium">
              {grupo.participants.length} {t("participantes")}
            </p>
            <ul className="space-y-2">
              {ordenados.map((p) => (
                <li
                  key={p.id}
                  className="flex flex-wrap items-center justify-between gap-2 rounded-md border p-2"
                >
                  <div className="min-w-0">
                    <p className="truncate text-sm">{rotulo(p)}</p>
                    {p.contact && p.phone && (
                      <p className="text-xs text-muted-foreground">{p.phone}</p>
                    )}
                  </div>
                  <div className="flex items-center gap-1">
                    {p.role !== "participant" && (
                      <Badge variant="secondary">
                        {p.role === "superadmin" ? t("Criador") : t("Admin")}
                      </Badge>
                    )}
                    {p.role === "participant" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={ocupado}
                        onClick={() => void alterar("promote", { participant_ids: [p.id] })}
                      >
                        {t("Tornar admin")}
                      </Button>
                    )}
                    {p.role === "admin" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={ocupado}
                        onClick={() => void alterar("demote", { participant_ids: [p.id] })}
                      >
                        {t("Tirar admin")}
                      </Button>
                    )}
                    {p.role !== "superadmin" && (
                      <Button
                        size="sm"
                        variant="ghost"
                        disabled={ocupado}
                        onClick={() => setConfirmarRemocao(p)}
                      >
                        {t("Remover")}
                      </Button>
                    )}
                  </div>
                </li>
              ))}
            </ul>
            {confirmarRemocao && (
              <div role="alertdialog" className="rounded-md border p-3 text-sm">
                <p>
                  {t("Remover do grupo")} {rotulo(confirmarRemocao)}?
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      const p = confirmarRemocao;
                      setConfirmarRemocao(null);
                      void alterar("remove", { participant_ids: [p.id] });
                    }}
                  >
                    {t("Remover")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirmarRemocao(null)}>
                    {t("Cancelar")}
                  </Button>
                </div>
              </div>
            )}
          </section>

          <section className="space-y-2 border-t pt-3">
            {!confirmarSaida ? (
              <Button
                size="sm"
                variant="outline"
                disabled={ocupado}
                onClick={() => setConfirmarSaida(true)}
              >
                {t("Sair do grupo")}
              </Button>
            ) : (
              <div role="alertdialog" className="rounded-md border p-3 text-sm">
                <p>
                  {t(
                    "O número conectado sai deste grupo. Para voltar, alguém que ficou precisa convidá-lo de novo.",
                  )}
                </p>
                <div className="mt-2 flex gap-2">
                  <Button
                    size="sm"
                    onClick={() => {
                      setConfirmarSaida(false);
                      void escrever(
                        () =>
                          fetch(caminhoDoGrupo(channelId, chatId, "/leave"), { method: "POST" }),
                        async () => onVoltar(true),
                      );
                    }}
                  >
                    {t("Sair mesmo assim")}
                  </Button>
                  <Button size="sm" variant="outline" onClick={() => setConfirmarSaida(false)}>
                    {t("Cancelar")}
                  </Button>
                </div>
              </div>
            )}
          </section>
        </div>
      )}
    </div>
  );
}

export function CriarGrupo({
  channelId,
  onVoltar,
  onCriado,
}: {
  channelId: string;
  onVoltar: () => void;
  onCriado: (chatId: string, resumo: string) => void;
}) {
  const t = useT();
  const [nome, setNome] = useState("");
  const [telefones, setTelefones] = useState("");
  const [erro, setErro] = useState<string | null>(null);
  const [ocupado, setOcupado] = useState(false);
  // Uma chave por formulário: clique duplo ou retentativa devolve o MESMO grupo,
  // em vez de criar dois no WhatsApp.
  const [chave] = useState(() => crypto.randomUUID());

  const lista = telefonesDoTexto(telefones);

  async function criar() {
    setOcupado(true);
    setErro(null);
    try {
      const res = await fetch(`/api/v1/channel-sessions/${channelId}/groups`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "Idempotency-Key": chave },
        body: JSON.stringify({ subject: nome.trim(), phones: lista }),
      });
      if (!res.ok) {
        setErro(t(await mensagemDeErro(res, "Não foi possível criar o grupo.")));
        return;
      }
      const j = (await res.json()) as {
        data: { chatId: string; adicionados: number; naoEntraram: string[]; semWhatsapp: string[] };
      };
      const partes = [`${t("Grupo criado com")} ${j.data.adicionados} ${t("participantes")}.`];
      if (j.data.naoEntraram.length) {
        partes.push(
          `${t("Não entraram (só aceitam convite — mande o link)")}: ${j.data.naoEntraram.join(", ")}.`,
        );
      }
      if (j.data.semWhatsapp.length)
        partes.push(`${t("Sem WhatsApp")}: ${j.data.semWhatsapp.join(", ")}.`);
      onCriado(j.data.chatId, partes.join(" "));
    } finally {
      setOcupado(false);
    }
  }

  return (
    <div className="flex flex-col gap-3 pt-3">
      <div>
        <Button variant="ghost" size="sm" onClick={onVoltar}>
          ← {t("Voltar aos grupos")}
        </Button>
      </div>
      <Label htmlFor="novo-grupo-nome">{t("Nome do grupo")}</Label>
      <Input
        id="novo-grupo-nome"
        value={nome}
        maxLength={100}
        onChange={(e) => setNome(e.target.value)}
      />
      <Label htmlFor="novo-grupo-telefones">{t("Participantes")}</Label>
      <Textarea
        id="novo-grupo-telefones"
        rows={5}
        value={telefones}
        placeholder={t("Um telefone por linha, com DDD. Ex.: 31 99999-0000")}
        onChange={(e) => setTelefones(e.target.value)}
      />
      <p className="text-xs text-muted-foreground">
        {t(
          "O número conectado cria o grupo e fica como administrador. Quem só aceita convite não entra direto: mande o link depois.",
        )}
      </p>
      {erro && (
        <p role="alert" className="text-sm text-destructive">
          {erro}
        </p>
      )}
      <div>
        <Button
          disabled={ocupado || nome.trim() === "" || lista.length === 0 || lista.length > 50}
          onClick={() => void criar()}
        >
          {ocupado ? t("Criando…") : t("Criar grupo")}
        </Button>
      </div>
    </div>
  );
}
