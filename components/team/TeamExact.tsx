"use client";

/**
 * Team — the Dashboard v2 screen, rendered exactly.
 *
 * The design draws this screen unconditionally: header with a seat meter,
 * Invite people, Members, the capability matrix, Pending invites and Recent
 * access events. Entitlement is a property of the invite action, never a
 * replacement for the page — a workspace that cannot add a seat can still read
 * who is in it.
 */
import { useState } from "react";

import styles from "@/components/team/TeamExact.module.css";
import {
  INVITE_ROLE_OPTIONS,
  ROLE_TO_DESIGN,
  type StoredTeamRole,
  type TeamExactModel,
  type TeamMemberModel,
} from "@/components/team/team-exact-adapter";

export interface TeamExactProps {
  model: TeamExactModel;
  invite: {
    emails: string;
    role: StoredTeamRole;
    scope: "all" | "this";
    pending: boolean;
  };
  flash: { tone: "success" | "error"; text: string } | null;
  onInviteChange: (next: Partial<TeamExactProps["invite"]>) => void;
  onSendInvite: () => void;
  onResendInvite: (inviteId: string) => void;
  onRevokeInvite: (inviteId: string) => void;
  onChangeRole: (membershipId: string, role: StoredTeamRole) => void;
  onRemoveMember: (membershipId: string) => void;
}

export function TeamExact({
  model,
  invite,
  flash,
  onInviteChange,
  onSendInvite,
  onResendInvite,
  onRevokeInvite,
  onChangeRole,
  onRemoveMember,
}: TeamExactProps) {
  const [menuFor, setMenuFor] = useState<string | null>(null);

  return (
    <section className={styles.root} data-screen-label="Team">
      <div className={styles.header}>
        <div>
          <p className={styles.eyebrow}>{model.eyebrow}</p>
          <h1 className={styles.title}>{model.title}</h1>
        </div>
        <div className={styles.seats}>
          <div className={styles.seatsText}>
            <p className={styles.seatsEyebrow}>{model.seats.eyebrow}</p>
            <p className={styles.seatsValue}>{model.seats.value}</p>
          </div>
          <div className={styles.seatsTrack}>
            <div className={styles.seatsFill} style={{ width: model.seats.fill }} />
          </div>
        </div>
      </div>

      {flash ? (
        <p
          className={`${styles.flash} ${
            flash.tone === "success" ? styles.flashSuccess : styles.flashError
          }`}
          role="status"
        >
          {flash.text}
        </p>
      ) : null}

      <article className={`${styles.card} ${styles.cardPadded}`}>
        <h2 className={styles.inviteTitle}>Invite people</h2>
        <div className={styles.inviteRow}>
          <input
            className={styles.inviteInput}
            placeholder="teammate@company.com"
            aria-label="Invite email"
            value={invite.emails}
            onChange={(event) => onInviteChange({ emails: event.target.value })}
          />
          <select
            className={styles.inviteSelect}
            aria-label="Invite role"
            value={invite.role}
            onChange={(event) => onInviteChange({ role: event.target.value as StoredTeamRole })}
          >
            {INVITE_ROLE_OPTIONS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select
            className={styles.inviteSelect}
            aria-label="Invite scope"
            value={invite.scope}
            onChange={(event) => onInviteChange({ scope: event.target.value as "all" | "this" })}
          >
            {model.scopeOptions.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={styles.inviteButton}
            onClick={onSendInvite}
            disabled={!model.canInvite || invite.pending}
          >
            Send invite
          </button>
        </div>
        <p className={styles.inviteNote}>
          {model.canInvite
            ? "Roles gate provider writes server-side — a Viewer can never trigger a Launchpad write, whatever the UI shows. Invites expire after 7 days."
            : (model.inviteBlockedReason ??
              "Roles gate provider writes server-side — a Viewer can never trigger a Launchpad write, whatever the UI shows. Invites expire after 7 days.")}
        </p>
      </article>

      <article className={`${styles.card} ${styles.cardScroll}`}>
        <div className={styles.cardHead}>
          <h2 className={styles.cardTitle}>Members</h2>
          <span className={styles.cardSub}>{model.memberCount}</span>
        </div>
        <table className={styles.table}>
          <thead>
            <tr>
              <th className={`${styles.th} ${styles.thLead}`}>Member</th>
              <th className={styles.th}>Role</th>
              <th className={styles.th}>Scope</th>
              <th className={styles.th}>2FA</th>
              <th className={`${styles.th} ${styles.thRight}`}>Actions · 28d</th>
              <th className={`${styles.th} ${styles.thRight}`}>Last active</th>
              <th className={`${styles.th} ${styles.thLead}`} />
            </tr>
          </thead>
          <tbody>
            {model.members.length === 0 ? (
              <tr className={styles.row}>
                <td className={styles.emptyCell} colSpan={7}>
                  No members found for this workspace.
                </td>
              </tr>
            ) : (
              model.members.map((member: TeamMemberModel) => (
                <tr key={member.membershipId} className={styles.row}>
                  <td className={styles.memberCell}>
                    <div className={styles.memberInner}>
                      <span
                        className={styles.avatar}
                        style={{ background: member.avatarBackground }}
                      >
                        {member.initials}
                      </span>
                      <span style={{ minWidth: 0 }}>
                        <span className={styles.memberName}>{member.name}</span>
                        <span className={styles.memberEmail}>{member.email}</span>
                      </span>
                    </div>
                  </td>
                  <td className={styles.cell}>
                    <span
                      className={styles.roleChip}
                      style={{
                        background: member.roleBackground,
                        color: member.roleForeground,
                      }}
                    >
                      {member.role}
                    </span>
                  </td>
                  <td className={styles.scopeCell}>{member.scope}</td>
                  <td className={styles.cell}>
                    <span
                      className={styles.faChip}
                      style={{
                        background: member.twoFactorBackground,
                        color: member.twoFactorForeground,
                      }}
                    >
                      {member.twoFactor}
                    </span>
                  </td>
                  <td className={styles.actionsCell}>{member.actions}</td>
                  <td className={styles.activeCell}>{member.lastActive}</td>
                  <td className={styles.menuCell}>
                    <button
                      type="button"
                      title="Manage member"
                      aria-label={`Manage ${member.name}`}
                      className={styles.menuButton}
                      onClick={() =>
                        setMenuFor((current) =>
                          current === member.membershipId ? null : member.membershipId,
                        )
                      }
                    >
                      ⋯
                    </button>
                    {menuFor === member.membershipId ? (
                      <div className={styles.menu}>
                        {INVITE_ROLE_OPTIONS.filter(
                          (option) => option.value !== member.storedRole,
                        ).map((option) => (
                          <button
                            key={option.value}
                            type="button"
                            className={styles.menuItem}
                            onClick={() => {
                              setMenuFor(null);
                              onChangeRole(member.membershipId, option.value);
                            }}
                          >
                            Make {ROLE_TO_DESIGN[option.value]}
                          </button>
                        ))}
                        {member.removable ? (
                          <button
                            type="button"
                            className={`${styles.menuItem} ${styles.menuItemDanger}`}
                            onClick={() => {
                              setMenuFor(null);
                              onRemoveMember(member.membershipId);
                            }}
                          >
                            Remove from workspace
                          </button>
                        ) : null}
                      </div>
                    ) : null}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </article>

      <div className={styles.lowerGrid}>
        <article className={`${styles.card} ${styles.cardScroll}`}>
          <div className={styles.cardHead}>
            <h2 className={styles.cardTitle}>What each role can do</h2>
            <span className={styles.cardSub}>enforced server-side on every call</span>
          </div>
          <table className={styles.matrixTable}>
            <thead>
              <tr>
                <th className={`${styles.th} ${styles.thLead}`}>Capability</th>
                <th className={`${styles.th} ${styles.thCenter}`}>Owner</th>
                <th className={`${styles.th} ${styles.thCenter}`}>Operator</th>
                <th className={`${styles.th} ${styles.thCenter}`}>Analyst</th>
                <th className={`${styles.th} ${styles.thCenter} ${styles.thLead}`}>Viewer</th>
              </tr>
            </thead>
            <tbody>
              {model.capabilities.map((row) => (
                <tr key={row.label} className={styles.matrixRow}>
                  <td className={styles.matrixLabel}>{row.label}</td>
                  {row.cells.map((cell, index) => (
                    <td
                      key={`${row.label}-${index}`}
                      className={styles.matrixCell}
                      style={{ color: cell.foreground }}
                      title={cell.note ?? undefined}
                    >
                      {cell.value}
                    </td>
                  ))}
                </tr>
              ))}
            </tbody>
          </table>
        </article>

        <div className={styles.column}>
          <article className={`${styles.card} ${styles.cardClipped}`}>
            <div className={styles.cardHead}>
              <h2 className={styles.cardTitle}>Pending invites</h2>
              <span className={styles.cardSub}>{model.invites.length}</span>
            </div>
            {model.invites.length === 0 ? (
              <p className={styles.emptyLine}>No pending invites.</p>
            ) : (
              model.invites.map((pendingInvite) => (
                <div key={pendingInvite.id} className={styles.inviteListRow}>
                  <div className={styles.inviteListBody}>
                    <p className={styles.inviteListEmail}>{pendingInvite.email}</p>
                    <p className={styles.inviteListMeta}>{pendingInvite.meta}</p>
                  </div>
                  <span className={styles.inviteListRole}>{pendingInvite.role}</span>
                  <button
                    type="button"
                    className={`${styles.inviteAction} ${styles.inviteResend}`}
                    onClick={() => onResendInvite(pendingInvite.id)}
                  >
                    Resend
                  </button>
                  <button
                    type="button"
                    className={`${styles.inviteAction} ${styles.inviteRevoke}`}
                    onClick={() => onRevokeInvite(pendingInvite.id)}
                  >
                    Revoke
                  </button>
                </div>
              ))
            )}
          </article>

          <article className={`${styles.card} ${styles.cardClipped}`}>
            <div className={styles.cardHead}>
              <h2 className={styles.cardTitle}>Recent access events</h2>
            </div>
            {model.accessEvents.length === 0 ? (
              <p className={styles.emptyLine}>No access events recorded.</p>
            ) : (
              model.accessEvents.map((event) => (
                <div key={event.id} className={styles.eventRow}>
                  <span className={styles.eventTime}>{event.time}</span>
                  <p className={styles.eventText}>
                    <b className={styles.eventWho}>{event.who}</b> {event.what}
                  </p>
                </div>
              ))
            )}
            <p className={styles.cardFoot}>full audit trail lives in the Automation ledger</p>
          </article>
        </div>
      </div>
    </section>
  );
}

export default TeamExact;
