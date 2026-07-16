"use client";

import { useEffect } from "react";

export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    console.error("GoalDrop route error", {
      message: error.message,
      digest: error.digest,
    });
  }, [error]);
  return (
    <section className="empty-page" role="alert">
      <p className="section-kicker">Connection interrupted</p>
      <h1>The match view needs another attempt.</h1>
      <p className="lede">
        No receipt or submitted request has been interpreted as a win. Retry
        safely to refresh confirmed Devnet state.
      </p>
      <button type="button" className="primary-button" onClick={reset}>
        Retry this view
      </button>
    </section>
  );
}
