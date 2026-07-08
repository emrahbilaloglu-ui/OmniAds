"use client";

import { FormEvent, useState } from "react";
interface BusinessFormProps {
  onSubmit: (payload: {
    name: string;
    currency: string;
  }) => void;
}

const CURRENCY_OPTIONS = ["USD", "EUR", "GBP", "TRY"];

export function BusinessForm({ onSubmit }: BusinessFormProps) {
  const [name, setName] = useState("");
  const [currency, setCurrency] = useState("USD");

  const isDisabled = name.trim().length < 2;

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (isDisabled) return;

    onSubmit({
      name: name.trim(),
      currency,
    });
  }

  return (
    <form onSubmit={handleSubmit} className="ad-auth-form">
      <label htmlFor="business-name" className="ad-auth-label">
        Business name
        <input
          id="business-name"
          value={name}
          onChange={(event) => setName(event.target.value)}
          placeholder="Your business name"
          className="ad-auth-input"
        />
      </label>

      <label htmlFor="business-currency" className="ad-auth-label">
        Currency
        <select
          id="business-currency"
          value={currency}
          onChange={(event) => setCurrency(event.target.value)}
          className="ad-auth-select"
        >
          {CURRENCY_OPTIONS.map((item) => (
            <option key={item} value={item}>
              {item}
            </option>
          ))}
        </select>
      </label>

      <button type="submit" className="ad-auth-primary" disabled={isDisabled}>
        Create business
      </button>
    </form>
  );
}
