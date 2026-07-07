"use client";

import { COUNTRIES, splitPhone } from "@/lib/countries";
import { Selector } from "@astryxdesign/core/Selector";
import { Stack } from "@astryxdesign/core/Stack";
import { Text } from "@astryxdesign/core/Text";
import { TextInput } from "@astryxdesign/core/TextInput";
import { useEffect, useState } from "react";

const OPTIONS = COUNTRIES.map((c) => ({ value: c.iso, label: `${c.flag} ${c.name} (${c.dial})` }));
const dialFor = (iso: string) => COUNTRIES.find((c) => c.iso === iso)?.dial ?? "+27";

/**
 * Mobile-number input with a country dial-code selector (defaults to 🇿🇦 +27).
 * Emits a combined E.164-ish string ("+27821234567"), or "" when cleared. A single
 * leading trunk 0 on the national part is dropped (082… → +2782…).
 */
export function PhoneInput({
  value,
  onChange,
  label = "Mobile number",
  description,
  isDisabled,
}: {
  value: string;
  onChange: (full: string) => void;
  label?: string;
  description?: string;
  isDisabled?: boolean;
}) {
  const initial = splitPhone(value);
  const [iso, setIso] = useState(initial.iso);
  const [national, setNational] = useState(initial.national);

  // Re-sync when the stored value arrives/changes from outside (e.g. from the API).
  useEffect(() => {
    const s = splitPhone(value);
    setIso(s.iso);
    setNational(s.national);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [value]);

  const emit = (nextIso: string, nextNational: string) => {
    const digits = nextNational.replace(/\D/g, "").replace(/^0+/, "");
    onChange(digits ? `${dialFor(nextIso)}${digits}` : "");
  };

  return (
    <Stack gap={1}>
      {label ? <Text type="supporting">{label}</Text> : null}
      <Stack direction="horizontal" gap={2} align="start">
        <Selector
          label="Country code"
          isLabelHidden
          options={OPTIONS}
          value={iso}
          onChange={(v) => {
            setIso(v);
            emit(v, national);
          }}
          width={240}
        />
        <TextInput
          label="Number"
          isLabelHidden
          type="text"
          placeholder="82 123 4567"
          value={national}
          onChange={(v) => {
            setNational(v);
            emit(iso, v);
          }}
          isDisabled={isDisabled}
          width={200}
        />
      </Stack>
      {description ? <Text type="supporting">{description}</Text> : null}
    </Stack>
  );
}
