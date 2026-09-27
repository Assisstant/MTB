-- Обележувачите на сопственикот во WBACC Studio (сопственикот, 27 септември 2026).
--
-- Досега живееја во еден прелистувач (BookmarksPlus): друг компјутер не ги
-- гледаше, а исчистен прелистувач ги губеше. Сега се на серверот, САМО ЗА
-- АДМИНИСТРАТОРОТ — ги чита и ги пишува само тој (routes/bookmarks.ts); WBACC
-- чува копија во прелистувачот за да работи и без сервер.
--
-- ЕДЕН ДОКУМЕНТ со верзија, не редови по картичка: пишува еден човек, и
-- прашањето што треба да се одговори е „дали некој друг компјутер зачувал во
-- меѓувреме", не спојување. Зачувувањето ја наведува верзијата од која
-- тргнало; ако таа веќе не е последна, серверот одбива (409) и одлучува
-- човекот — никогаш тивко препишување. Празен документ не брише полн.
-- Облик: табли → колони → картички (линк, наслов, ознаки, белешка, закачено),
-- ист како извозот на BookmarksPlus; го проверува lib/bookmarks.ts.

CREATE TABLE bookmark_state (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  doc jsonb NOT NULL,
  revision integer NOT NULL CHECK (revision >= 1),
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT ''
);

-- The MTB server's own table, never the Supabase browser Data API (036).
ALTER TABLE bookmark_state ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON bookmark_state FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON bookmark_state FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE bookmark_state IS 'Обележувачите на администраторот (WBACC Studio): еден документ со верзија; само тој ги чита и пишува (routes/bookmarks.ts).';
