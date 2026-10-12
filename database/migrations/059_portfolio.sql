-- Доказите на сопственикот за звањето „стручен соработник – ментор" (сопственикот, 12 октомври 2026).
--
-- Досега живееја во еден прелистувач (TabelaSoDokazi_.html, localStorage) и во
-- рачно извезена датотека: исчистен прелистувач ги губеше, а табелата беше ред
-- по индикатор, па ист доказ се препишуваше кај секој индикатор што го покрива
-- и неговите датотеки се копираа во папка по индикатор. Сега ДОКАЗОТ постои
-- еднаш, а врската доказ ↔ индикатор го носи образложението; табелата, папките
-- и покриеноста се читаат од врските (Dokazi.html).
--
-- ЕДЕН ДОКУМЕНТ со верзија, како обележувачите (047) и од истата причина:
-- пишува еден човек, и прашањето е „дали друг компјутер зачувал во меѓувреме",
-- не спојување. Зачувувањето ја наведува верзијата од која тргнало; ако таа веќе
-- не е последна, серверот одбива (409) и одлучува човекот. Празен документ не
-- брише полн. Обликот го проверува lib/portfolio.ts.
--
-- Самите датотеки (слики, PDF, видеа) НЕ се тука: остануваат во папка на
-- компјутерот на сопственикот, секоја еднаш; документот го чува само нивното име.

CREATE TABLE portfolio_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  doc jsonb NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT ''
);

-- The MTB server's own table, never the Supabase browser Data API (036).
ALTER TABLE portfolio_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON portfolio_state FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON portfolio_state FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE portfolio_state IS 'Доказите на администраторот за звањето ментор (Dokazi.html): еден документ со верзија; само тој го чита и пишува (routes/portfolio.ts).';
