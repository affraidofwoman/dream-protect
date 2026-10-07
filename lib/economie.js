import { MessageFlags, PermissionFlagsBits } from 'discord.js';
import { audit, cfg, db, idOf, money, now, setCfg, toCents, transaction } from './base.js';
import { acting } from './bots.js';
import { allowed, checkRole, checkTarget } from './droits.js';
import { log } from './logs.js';
import { E, SAY, button, dot, form, info, msg, ok, pair, panel, pickUser, row, select, small, view } from './ui.js';

const field = (i, id) => i.fields.getTextInputValue(id)?.trim() ?? '';
const cur = (gid) => cfg(gid).payment.currency;

// Catalogue des prix
export const KINDS = {
  perm: { label: 'Rôles', emoji: '🎭', intro: 'Les rôles à débloquer.' },
  acces: { label: 'Whitelists', emoji: '🔑', intro: 'Les accès à débloquer.' },
  abo: { label: 'Abonnements', emoji: '💳', intro: 'Renouvelés chaque mois.' },
};
export const prices = (gid, kind = null) =>
  db
    .prepare('SELECT * FROM prices WHERE guild_id=? AND active=1 ORDER BY amount DESC')
    .all(gid)
    .filter((p) => !kind || p.key.startsWith(`${kind}:`));
function catalog(ctx, kind) {
  const k = KINDS[kind];
  const rows = prices(ctx.gid, kind);
  return panel(ctx, {
    title: k.label,
    emoji: k.emoji,
    intro: k.intro,
    sections: [
      {
        emoji: E.money,
        name: 'Tarifs',
        lines: rows.length
          ? rows.map((p) => `${dot(p.label, money(p.amount, cur(ctx.gid)))}${p.description ? `\n${small(p.description)}` : ''}`)
          : [dot('Rien de publié pour le moment')],
      },
    ],
    outro: `Pour en profiter, ouvre un ticket **Contribution**. Moyens : ${cfg(ctx.gid).payment.methods.join(' · ')}`,
  });
}

// Textes d'explication
const EXPLAIN =
  'Contribuer, c’est soutenir le serveur et débloquer des avantages.\n\n`/perm` les rôles · `/acces` les whitelists · `/abo` les abonnements.';
const CONTRIB =
  'Chaque contribution fait vivre le serveur et ouvre des accès.\n\n**1.** Choisis ce qui te plaît dans `/perm`, `/acces` ou `/abo`.\n**2.** Ouvre un ticket **Contribution**.\n**3.** Règle avec un des moyens proposés, le staff valide.\n**4.** Ton accès est donné et ta contribution est enregistrée.';
async function explainCmd(ctx, long) {
  const t = cfg(ctx.gid).texts;
  return ctx.send(
    msg(
      view(ctx, {
        title: long ? 'Contribuer' : 'En bref',
        emoji: '💡',
        text: (long ? t.contrib : t.explain) || (long ? CONTRIB : EXPLAIN),
      }),
      { private: true },
    ),
  );
}

// Réglage des prix
function pricesView(ctx) {
  const rows = prices(ctx.gid);
  return msg(
    panel(ctx, {
      title: 'Prix',
      emoji: E.money,
      sections: Object.entries(KINDS).map(([kind, k]) => ({
        emoji: k.emoji,
        name: k.label,
        lines: rows.filter((p) => p.key.startsWith(`${kind}:`)).map((p) => dot(p.label, money(p.amount, cur(ctx.gid)))),
      })),
      outro: small(`Moyens de paiement : ${cfg(ctx.gid).payment.methods.join(' · ')} · devise ${cur(ctx.gid)}`),
    }),
    {
      components: [
        row(
          button('eco:add', 'Ajouter', 'vert', '➕'),
          button('eco:drop', 'Retirer', 'rouge', '➖'),
          button('eco:methods', 'Moyens', 'gris', E.card),
          button('eco:texts', 'Textes', 'gris', '✏️'),
        ),
      ],
    },
  );
}
async function pricesComponent(i, ctx, [action, arg]) {
  if (!allowed(ctx.gid, ctx.user.id, '=prix', ctx.member)) throw new Error(SAY.denied);
  if (action === 'add') {
    return i.showModal(
      form('eco:save', 'Nouveau prix', [
        { id: 'kind', label: 'Type : perm, acces ou abo', value: 'perm', max: 5 },
        { id: 'label', label: 'Nom', max: 80 },
        { id: 'amount', label: `Prix (${cur(ctx.gid)})`, max: 10 },
        { id: 'desc', label: 'Petite description', required: false, max: 150 },
      ]),
    );
  }
  if (action === 'save') {
    const kind = field(i, 'kind').toLowerCase();
    if (!KINDS[kind]) throw new Error('Le type doit être perm, acces ou abo.');
    const label = field(i, 'label');
    const amount = toCents(field(i, 'amount'));
    if (!label || !amount) throw new Error('Nom et prix valides obligatoires.');
    const key = `${kind}:${label
      .toLowerCase()
      .normalize('NFKD')
      .replace(/[^a-z0-9]+/g, '-')
      .slice(0, 40)}`;
    db.prepare(
      'INSERT INTO prices(guild_id,key,label,amount,active,description) VALUES(?,?,?,?,1,?) ON CONFLICT(guild_id,key) DO UPDATE SET label=excluded.label,amount=excluded.amount,active=1,description=excluded.description',
    ).run(ctx.gid, key, label, amount, field(i, 'desc') || null);
    await log(ctx.guild, 'vente', {
      title: 'Prix enregistré',
      tone: 'info',
      by: ctx.user,
      lines: [pair('Type', KINDS[kind].label), pair('Nom', label), pair('Prix', money(amount, cur(ctx.gid)))],
    });
    return i.reply(pricesView(ctx));
  }
  if (action === 'drop') {
    const rows = prices(ctx.gid);
    if (!rows.length) throw new Error('Aucun prix à retirer.');
    return i.reply(
      msg(info(ctx, 'Lequel retirer ?', { title: 'Prix', emoji: E.money }), {
        private: true,
        components: [
          row(
            select(
              'eco:gone',
              'Prix à retirer',
              rows.map((p) => ({ label: p.label, value: p.key, description: money(p.amount, cur(ctx.gid)) })),
            ),
          ),
        ],
      }),
    );
  }
  if (action === 'gone') {
    const p = db.prepare('SELECT * FROM prices WHERE guild_id=? AND key=?').get(ctx.gid, i.values[0]);
    db.prepare('UPDATE prices SET active=0 WHERE guild_id=? AND key=?').run(ctx.gid, i.values[0]);
    await log(ctx.guild, 'vente', { title: 'Prix retiré', tone: 'alerte', by: ctx.user, lines: [pair('Nom', p?.label ?? i.values[0])] });
    return i.update(msg(ok(ctx, `**${p?.label}** retiré.`, { title: 'Prix', emoji: E.money }), { components: [] }));
  }
  if (action === 'methods') {
    const p = cfg(ctx.gid).payment;
    return i.showModal(
      form('eco:methodsave', 'Moyens de paiement', [
        { id: 'methods', label: 'Moyens, séparés par des virgules', value: p.methods.join(', '), max: 300 },
        { id: 'currency', label: 'Devise', value: p.currency, max: 4 },
      ]),
    );
  }
  if (action === 'methodsave') {
    const methods = field(i, 'methods')
      .split(',')
      .map((x) => x.trim())
      .filter(Boolean)
      .slice(0, 10);
    setCfg(ctx.gid, (c) => {
      c.payment.methods = methods.length ? methods : c.payment.methods;
      c.payment.currency = field(i, 'currency') || c.payment.currency;
    });
    return i.reply(pricesView(ctx));
  }
  if (action === 'texts') {
    const t = cfg(ctx.gid).texts;
    return i.showModal(
      form('eco:textsave', 'Textes /explain et /contrib', [
        { id: 'explain', label: '/explain (en bref)', long: true, value: t.explain || EXPLAIN, max: 2000 },
        { id: 'contrib', label: '/contrib (en détail)', long: true, value: t.contrib || CONTRIB, max: 3000 },
      ]),
    );
  }
  if (action === 'textsave') {
    setCfg(ctx.gid, (c) => {
      c.texts.explain = field(i, 'explain') || null;
      c.texts.contrib = field(i, 'contrib') || null;
    });
    return i.reply(msg(ok(ctx, 'Textes enregistrés.', { title: 'Prix', emoji: E.money }), { private: true }));
  }
}

// Paiements
export const PAY = { 'En attente': '🕗', Payé: '✅', Refusé: '⛔', Remboursé: '↩️', 'À vérifier': '🔎' };
const payLine = (gid, p) => `${PAY[p.status] ?? '•'} \`#${p.id}\` <@${p.user_id}> · ${p.label} · **${money(p.amount, cur(gid))}**`;
function paymentsView(ctx) {
  const rows = db.prepare('SELECT * FROM payments WHERE guild_id=? ORDER BY created_at DESC LIMIT 10').all(ctx.gid);
  const totals = db
    .prepare('SELECT status,COUNT(*) AS n,COALESCE(SUM(amount),0) AS total FROM payments WHERE guild_id=? GROUP BY status')
    .all(ctx.gid);
  return msg(
    panel(ctx, {
      title: 'Paiements',
      emoji: E.card,
      sections: [
        {
          emoji: '📈',
          name: 'Bilan',
          lines: Object.keys(PAY)
            .map((s) => totals.find((t) => t.status === s))
            .filter(Boolean)
            .map((t) => dot(`${PAY[t.status]} ${t.status}`, `${t.n} · ${money(t.total, cur(ctx.gid))}`)),
        },
        { emoji: '🧾', name: 'Derniers', lines: rows.length ? rows.map((p) => payLine(ctx.gid, p)) : [dot('Aucun paiement')] },
      ],
    }),
    {
      components: [row(button('pay:new', 'Nouveau', 'vert', '➕'), button('pay:status', 'Changer un statut', 'bleu', '🔁'))],
    },
  );
}
async function setStatus(ctx, id, status) {
  const p = db.prepare('SELECT * FROM payments WHERE guild_id=? AND id=?').get(ctx.gid, id);
  if (!p) throw new Error('Paiement introuvable.');
  if (!PAY[status]) throw new Error('Statut inconnu.');
  const abo = prices(ctx.gid, 'abo').find((x) => x.label.toLowerCase() === p.label.toLowerCase());
  const credit = status === 'Payé' && !p.credited;
  const refund = (status === 'Remboursé' || status === 'Refusé') && p.credited;
  // Écriture groupée
  transaction(() => {
    db.prepare('UPDATE payments SET status=?,updated_at=?,actor_id=? WHERE id=?').run(status, now(), ctx.user.id, id);
    if (credit) {
      db.prepare(
        'INSERT INTO contrib(guild_id,user_id,amount,updated_at) VALUES(?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET amount=amount+excluded.amount,updated_at=excluded.updated_at',
      ).run(ctx.gid, p.user_id, p.amount, now());
      db.prepare('UPDATE payments SET credited=1 WHERE id=?').run(id);
      if (abo) {
        db.prepare(
          'INSERT INTO subs(guild_id,user_id,label,until,created_at) VALUES(?,?,?,?,?) ON CONFLICT(guild_id,user_id,label) DO UPDATE SET until=MAX(COALESCE(until,0),?)+2592000000',
        ).run(ctx.gid, p.user_id, abo.label, now() + 30 * 864e5, now(), now());
      }
    }
    if (refund) {
      db.prepare('UPDATE contrib SET amount=MAX(0,amount-?),updated_at=? WHERE guild_id=? AND user_id=?').run(
        p.amount,
        now(),
        ctx.gid,
        p.user_id,
      );
      db.prepare('UPDATE payments SET credited=0 WHERE id=?').run(id);
    }
  });
  if (credit && abo) {
    await log(ctx.guild, 'abo', {
      title: 'Abonnement actif',
      tone: 'ok',
      by: ctx.user,
      lines: [pair('Membre', `<@${p.user_id}>`), pair('Abonnement', abo.label), pair('Durée', '30 jours de plus')],
    });
  }
  await log(ctx.guild, 'paiement', {
    title: 'Statut de paiement',
    tone: status === 'Payé' ? 'ok' : status === 'En attente' || status === 'À vérifier' ? 'info' : 'alerte',
    by: ctx.user,
    lines: [
      pair('Paiement', `#${id} · ${p.label}`),
      pair('Membre', `<@${p.user_id}>`),
      pair('Montant', money(p.amount, cur(ctx.gid))),
      pair('Statut', `${p.status} → **${status}**`),
    ],
  });
  audit(ctx.gid, ctx.user.id, 'payment.status', String(id), { status });
}
async function paymentsComponent(i, ctx, [action, arg]) {
  if (!allowed(ctx.gid, ctx.user.id, '/payment', ctx.member)) throw new Error(SAY.denied);
  if (action === 'new')
    return i.reply(
      msg(info(ctx, 'Pour qui ?', { title: 'Nouveau paiement', emoji: E.card }), { private: true, components: [row(pickUser('pay:who'))] }),
    );
  if (action === 'who') {
    const p = cfg(ctx.gid).payment;
    return i.showModal(
      form(`pay:create:${i.values[0]}`, 'Nouveau paiement', [
        { id: 'label', label: 'Pour quoi (nom du prix)', max: 80 },
        { id: 'amount', label: `Montant (${p.currency})`, max: 10 },
        { id: 'method', label: `Moyen (${p.methods.join(', ')})`.slice(0, 45), required: false, max: 40 },
        { id: 'note', label: 'Note', required: false, long: true, max: 300 },
      ]),
    );
  }
  if (action === 'create') {
    const amount = toCents(field(i, 'amount'));
    if (!amount) throw new Error('Montant invalide.');
    const seller = cfg(ctx.gid).defaultSeller ?? null;
    const res = db
      .prepare(
        'INSERT INTO payments(guild_id,user_id,label,amount,status,created_at,updated_at,method,note,actor_id,seller_id) VALUES(?,?,?,?,?,?,?,?,?,?,?)',
      )
      .run(
        ctx.gid,
        arg,
        field(i, 'label') || 'Paiement',
        amount,
        'En attente',
        now(),
        now(),
        field(i, 'method') || null,
        field(i, 'note') || null,
        ctx.user.id,
        seller,
      );
    await log(ctx.guild, 'paiement', {
      title: 'Paiement créé',
      tone: 'info',
      by: ctx.user,
      lines: [
        pair('Paiement', `#${res.lastInsertRowid}`),
        pair('Membre', `<@${arg}>`),
        pair('Pour', field(i, 'label') || 'Paiement'),
        pair('Montant', money(amount, cur(ctx.gid))),
        seller ? pair('Chercheur', `<@${seller}>`) : null,
      ],
    });
    return i.reply(
      msg(ok(ctx, `Paiement \`#${res.lastInsertRowid}\` créé, **En attente**.`, { title: 'Paiements', emoji: E.card }), {
        private: true,
        components: [
          row(
            select(
              `pay:set:${res.lastInsertRowid}`,
              'Changer le statut',
              Object.entries(PAY).map(([s, e]) => ({ label: s, value: s, emoji: e })),
            ),
          ),
        ],
      }),
    );
  }
  if (action === 'status') {
    const rows = db.prepare('SELECT * FROM payments WHERE guild_id=? ORDER BY created_at DESC LIMIT 25').all(ctx.gid);
    if (!rows.length) throw new Error('Aucun paiement.');
    return i.reply(
      msg(info(ctx, 'Lequel ?', { title: 'Paiements', emoji: E.card }), {
        private: true,
        components: [
          row(
            select(
              'pay:pick',
              'Paiement',
              rows.map((p) => ({
                label: `#${p.id} · ${p.label}`,
                value: String(p.id),
                description: `${p.status} · ${money(p.amount, cur(ctx.gid))}`,
                emoji: PAY[p.status],
              })),
            ),
          ),
        ],
      }),
    );
  }
  if (action === 'pick') {
    return i.update(
      msg(info(ctx, `Nouveau statut pour \`#${i.values[0]}\` ?`, { title: 'Paiements', emoji: E.card }), {
        components: [
          row(
            select(
              `pay:set:${i.values[0]}`,
              'Statut',
              Object.entries(PAY).map(([s, e]) => ({ label: s, value: s, emoji: e })),
            ),
          ),
        ],
      }),
    );
  }
  if (action === 'set') {
    await setStatus(ctx, Number(arg), i.values[0]);
    return i.update(
      msg(ok(ctx, `Paiement \`#${arg}\` : **${i.values[0]}**.`, { title: 'Paiements', emoji: PAY[i.values[0]] }), { components: [] }),
    );
  }
}

// Créditer et rôles
async function toggleRole(ctx, target, role, force = null) {
  const as = { ...ctx, guild: target.guild };
  checkRole(as, role);
  if (target.id !== ctx.user.id) checkTarget(as, target.id, target);
  const has = target.roles.cache.has(role.id);
  const add = force ?? !has;
  if (add === has) throw new Error(add ? `${target} a déjà ${role}.` : `${target} n’a pas ${role}.`);
  if (add) await target.roles.add(role, `Par ${ctx.user.tag}`);
  else await target.roles.remove(role, `Par ${ctx.user.tag}`);
  await log(ctx.guild, 'role', {
    title: add ? 'Rôle donné' : 'Rôle retiré',
    tone: add ? 'info' : 'alerte',
    by: ctx.user,
    lines: [pair('Membre', `<@${target.id}>`), pair('Rôle', `${role}`)],
  });
  return `${role} ${add ? 'donné à' : 'retiré à'} ${target}.`;
}
async function addCmd(ctx) {
  const user = ctx.opt('membre');
  const role = ctx.opt('role');
  const amount = toCents(ctx.opt('montant'));
  if (!user || (!role && !amount)) throw new Error('Choisis un membre, puis un rôle et/ou un montant.');
  const target = await acting(ctx.guild, PermissionFlagsBits.ManageRoles)
    .members.fetch(user.id)
    .catch(() => null);
  const lines = [];
  if (role) {
    if (!target) throw new Error('Ce membre n’est pas sur le serveur.');
    lines.push(await toggleRole(ctx, target, role));
  }
  if (amount) {
    db.prepare(
      'INSERT INTO contrib(guild_id,user_id,amount,updated_at) VALUES(?,?,?,?) ON CONFLICT(guild_id,user_id) DO UPDATE SET amount=amount+excluded.amount,updated_at=excluded.updated_at',
    ).run(ctx.gid, user.id, amount, now());
    const total = db.prepare('SELECT amount FROM contrib WHERE guild_id=? AND user_id=?').get(ctx.gid, user.id).amount;
    await log(ctx.guild, 'contrib', {
      title: 'Contribution créditée',
      tone: 'ok',
      by: ctx.user,
      lines: [pair('Membre', `<@${user.id}>`), pair('Montant', money(amount, cur(ctx.gid))), pair('Total', money(total, cur(ctx.gid)))],
    });
    audit(ctx.gid, ctx.user.id, 'contrib.add', user.id, { amount });
    lines.push(`${money(amount, cur(ctx.gid))} crédités à <@${user.id}> (total **${money(total, cur(ctx.gid))}**).`);
  }
  return ctx.send(msg(ok(ctx, lines.join('\n'), { title: 'Créditer', emoji: E.money })));
}
async function delCmd(ctx) {
  const user = ctx.opt('membre');
  const role = ctx.opt('role');
  const target = user
    ? await acting(ctx.guild, PermissionFlagsBits.ManageRoles)
        .members.fetch(user.id)
        .catch(() => null)
    : null;
  if (!target || !role) throw new Error('Choisis un membre présent et un rôle.');
  return ctx.send(msg(ok(ctx, await toggleRole(ctx, target, role, false), { title: 'Retirer un rôle', emoji: E.role })));
}
async function logsCmd(ctx) {
  const user = ctx.opt('membre');
  const gid = ctx.gid;
  const rows = user
    ? db.prepare('SELECT * FROM payments WHERE guild_id=? AND user_id=? ORDER BY created_at DESC LIMIT 20').all(gid, user.id)
    : db.prepare('SELECT * FROM payments WHERE guild_id=? ORDER BY created_at DESC LIMIT 20').all(gid);
  const total = user ? (db.prepare('SELECT amount FROM contrib WHERE guild_id=? AND user_id=?').get(gid, user.id)?.amount ?? 0) : null;
  const groups = {
    done: rows.filter((p) => p.status === 'Payé'),
    wait: rows.filter((p) => p.status === 'En attente' || p.status === 'À vérifier'),
    other: rows.filter((p) => p.status === 'Refusé' || p.status === 'Remboursé'),
  };
  return ctx.send(
    msg(
      panel(ctx, {
        title: user ? `Transactions de ${user.username}` : 'Transactions',
        emoji: '🧾',
        intro: user ? `${pair('Contribution totale', money(total, cur(gid)))}` : small('Les 20 dernières.'),
        sections: [
          { emoji: '✅', name: `Validés (${groups.done.length})`, lines: groups.done.map((p) => payLine(gid, p)) },
          { emoji: '🕗', name: `En cours (${groups.wait.length})`, lines: groups.wait.map((p) => payLine(gid, p)) },
          { emoji: '⛔', name: `Refusés ou remboursés (${groups.other.length})`, lines: groups.other.map((p) => payLine(gid, p)) },
        ],
        outro: rows.length ? null : 'Aucune transaction.',
      }),
      { private: true },
    ),
  );
}
async function defaultCmd(ctx) {
  const off = /^off$/i.test(ctx.args[0] || '');
  const id = off ? null : idOf(ctx.args[0]);
  const current = cfg(ctx.gid).defaultSeller;
  if (!id && !off) {
    const text = current ? `Chercheur par défaut : <@${current}>.` : 'Aucun chercheur par défaut.';
    const hint = small('`=default @membre` pour le changer, `=default off` pour l’enlever.');
    return ctx.send(msg(info(ctx, text, { title: 'Chercheur', emoji: E.search, lines: [hint] })));
  }
  setCfg(ctx.gid, (c) => (c.defaultSeller = id));
  await log(ctx.guild, 'vente', {
    title: 'Chercheur par défaut',
    tone: 'info',
    by: ctx.user,
    lines: [pair('Avant', current ? `<@${current}>` : '—'), pair('Maintenant', id ? `<@${id}>` : '—')],
  });
  const text = id
    ? `Chercheur par défaut : <@${id}>.\n${small('Il est crédité sur les nouveaux paiements.')}`
    : 'Plus de chercheur par défaut.';
  return ctx.send(msg(ok(ctx, text, { title: 'Chercheur', emoji: E.search })));
}

// Commandes
const memberOpt = (required = true) => ({ type: 'user', name: 'membre', description: 'Qui', required });
export const commands = [
  {
    name: '/explain',
    bot: 'main',
    section: 'contribuer',
    help: 'En bref',
    slash: { description: 'Contribuer, en bref', options: [] },
    run: (c) => explainCmd(c, false),
  },
  {
    name: '/contrib',
    bot: 'main',
    section: 'contribuer',
    help: 'En détail',
    slash: { description: 'Contribuer, en détail', options: [] },
    run: (c) => explainCmd(c, true),
  },
  {
    name: '/perm',
    bot: 'main',
    section: 'tarifs',
    help: 'Rôles',
    slash: { description: 'Tarifs des rôles', options: [] },
    run: (c) => c.send(msg(catalog(c, 'perm'), { private: true })),
  },
  {
    name: '/acces',
    bot: 'main',
    section: 'tarifs',
    help: 'Whitelists',
    slash: { description: 'Tarifs des whitelists', options: [] },
    run: (c) => c.send(msg(catalog(c, 'acces'), { private: true })),
  },
  {
    name: '/abo',
    bot: 'main',
    section: 'tarifs',
    help: 'Abonnements',
    slash: { description: 'Tarifs des abonnements', options: [] },
    run: (c) => c.send(msg(catalog(c, 'abo'), { private: true })),
  },
  {
    name: '/add',
    bot: 'main',
    section: 'argent',
    help: 'Donner (rôle ou montant)',
    slash: {
      description: 'Donner un rôle ou créditer',
      options: [
        memberOpt(),
        { type: 'role', name: 'role', description: 'Rôle à donner ou retirer' },
        { type: 'string', name: 'montant', description: 'Montant à créditer' },
      ],
    },
    run: addCmd,
  },
  {
    name: '/del',
    bot: 'main',
    section: 'argent',
    help: 'Retire un rôle',
    slash: {
      description: 'Retirer un rôle',
      options: [memberOpt(), { type: 'role', name: 'role', description: 'Quel rôle', required: true }],
    },
    run: delCmd,
  },
  {
    name: '/logs',
    bot: 'guard',
    section: 'argent',
    help: 'Transactions',
    slash: { description: 'Transactions', options: [memberOpt(false)] },
    run: logsCmd,
  },
  {
    name: '/payment',
    bot: 'guard',
    section: 'argent',
    help: 'Paiements',
    slash: { description: 'Suivre les paiements', options: [] },
    run: (c) => c.send({ ...paymentsView(c), flags: MessageFlags.Ephemeral }),
  },
  { name: '=prix', bot: 'guard', section: 'argent', help: 'Prix et moyens', run: (c) => c.send(pricesView(c)) },
  { name: '=default', bot: 'main', section: 'argent', help: 'Chercheur', run: defaultCmd },
];
export const components = { eco: pricesComponent, pay: paymentsComponent };
