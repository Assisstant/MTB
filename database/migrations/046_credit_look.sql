-- Изгледот на водениот жиг „изработил …" (сопственикот, 27 септември 2026).
--
-- Жигот стои на секој екран, кај секој колега и во облакот. Колку е проѕирен,
-- со каква боја и колку е голем го одредува САМО администраторот, еднаш за
-- сите: затоа е на серверот, а не во прелистувачот, каде што секој би можел
-- да го направи невидлив за себе. Самото ИМЕ не е тука: тоа е поставка на
-- инсталацијата (MTB_AUTHOR), никогаш во базата што оди во облакот и огледалото.
--
-- Еден ред, ништо повеќе: `id` е секогаш true. Содржината ја проверува
-- server/src/lib/author.ts (`normalizeLook`) пред да се запише, и истата
-- функција ја чита, па ред со непознат облик значи почетниот изглед, не грешка.

CREATE TABLE credit_look (
  id boolean PRIMARY KEY DEFAULT true CHECK (id),
  look jsonb NOT NULL,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by text NOT NULL DEFAULT ''
);

-- The MTB server's own table, never the Supabase browser Data API (036).
ALTER TABLE credit_look ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON credit_look FROM PUBLIC;
DO $$
DECLARE api_role text;
BEGIN
  FOREACH api_role IN ARRAY ARRAY['anon', 'authenticated'] LOOP
    IF EXISTS (SELECT 1 FROM pg_roles WHERE rolname = api_role) THEN
      EXECUTE format('REVOKE ALL ON credit_look FROM %I', api_role);
    END IF;
  END LOOP;
END $$;

COMMENT ON TABLE credit_look IS 'Изгледот на водениот жиг „изработил …“: боја, проѕирност и големина, еден ред за сите; го менува само администраторот (lib/author.ts).';
