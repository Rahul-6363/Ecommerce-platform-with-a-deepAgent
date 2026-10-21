"use client";

/**
 * Where it is going, and what to tell the courier — stated before the button.
 *
 * This exists because both checkout paths used to commit to an address the
 * buyer had never been shown. `/find` kept it behind a collapsed "Deliver
 * somewhere else" disclosure and `/shop` sent no address at all, so both
 * silently used `addresses[0]`. Shipping to the wrong place is not an error
 * anything downstream can catch — the delivery forecast and the risk score are
 * both confidently correct about the wrong city — which makes showing the
 * destination the one piece of checkout that cannot be collapsed.
 *
 * It also carries delivery instructions, which did not exist anywhere. They
 * are free text and dictatable on purpose: the cases that actually matter — a
 * guard, a gate code, a time window, a dog, a broken lift — are exactly the
 * ones no dropdown has an option for.
 *
 * Switching address stays behind a disclosure. Changing it is the uncommon
 * case, and a picker open by default pushes the button that commits off the
 * bottom of the screen.
 */

import { useCallback, useEffect, useState } from "react";
import AddressBook from "@/components/AddressBook";
import { api, Banner, Chip, Disclosure, VoiceNote } from "@/components/ui";

/** One saved address, as `/api/addresses` returns it. */
export type AddressRow = {
  index: number;
  label: string;
  oneLine: string;
  phone: string;
  advice: { field: string; severity: "blocking" | "worth_fixing"; message: string }[];
};

export default function DestinationBlock({
  addressIndex,
  onAddressChange,
  instructions,
  onInstructionsChange,
}: {
  addressIndex: number;
  onAddressChange: (i: number) => void;
  instructions: string;
  onInstructionsChange: (next: string) => void;
}) {
  const [rows, setRows] = useState<AddressRow[]>([]);
  const [loading, setLoading] = useState(true);

  const load = useCallback(async () => {
    try {
      const r = await api<{ addresses: AddressRow[] }>("/api/addresses");
      setRows(r.addresses ?? []);
    } catch {
      // A failed read here must not block the order: the server resolves the
      // index itself, so the worst case is this panel showing nothing.
      setRows([]);
    }
    setLoading(false);
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  const chosen = rows.find((a) => a.index === addressIndex) ?? rows[0];
  // Only what would actually cost this delivery something. The address book
  // is the place for the full list.
  const blocking = (chosen?.advice ?? []).filter((a) => a.severity === "blocking");
  const worth = (chosen?.advice ?? []).filter((a) => a.severity === "worth_fixing");

  return (
    <div style={{ display: "grid", gap: ".75rem" }}>
      <div style={{ display: "flex", gap: ".5rem", alignItems: "baseline", flexWrap: "wrap" }}>
        <span style={{ fontSize: ".78rem", fontWeight: 600 }}>Delivering to</span>
        {chosen && <Chip tone="neutral">{chosen.label}</Chip>}
      </div>

      {loading ? (
        <div className="skeleton" style={{ height: "2.4rem" }} />
      ) : !chosen ? (
        <Banner tone="gold">
          There is no saved address yet. Add one below and it becomes the destination
          for this order.
        </Banner>
      ) : (
        <div
          style={{
            fontSize: ".86rem", lineHeight: 1.6, padding: ".6rem .7rem",
            background: "var(--paper-sunk)", borderRadius: 8,
          }}
        >
          {chosen.oneLine}
          {chosen.phone && (
            <span className="mono" style={{ color: "var(--ink-soft)" }}> · {chosen.phone}</span>
          )}
        </div>
      )}

      {blocking.map((a, i) => (
        <Banner key={`b${i}`} tone="brick">{a.message}</Banner>
      ))}
      {worth.map((a, i) => (
        <div key={`w${i}`} style={{ fontSize: ".78rem", color: "var(--haldi-deep)", lineHeight: 1.5 }}>
          {a.message}
        </div>
      ))}

      <VoiceNote
        label="Anything the courier should know?"
        value={instructions}
        onChange={onInstructionsChange}
        rows={2}
        placeholder="Leave it with the guard, call before 7pm, gate code 4417…"
        hint="Optional. Goes on this delivery only, not saved to your address."
      />

      <Disclosure summary="Deliver somewhere else">
        <AddressBook
          picked={addressIndex}
          onPick={(i) => {
            onAddressChange(i);
            // The list may have gained a row: a buyer who adds an address here
            // is choosing it, and the panel above must show the new one.
            void load();
          }}
          compact
        />
      </Disclosure>
    </div>
  );
}
