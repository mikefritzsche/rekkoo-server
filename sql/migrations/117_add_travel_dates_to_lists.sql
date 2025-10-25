-- 117_add_travel_dates_to_lists.sql
-- Adds travel window columns to lists to support packing trip metadata

ALTER TABLE public.lists
  ADD COLUMN IF NOT EXISTS travel_start_date TIMESTAMPTZ;

ALTER TABLE public.lists
  ADD COLUMN IF NOT EXISTS travel_end_date TIMESTAMPTZ;

-- Helpful index for querying upcoming trips (optional but cheap with partial index)
CREATE INDEX IF NOT EXISTS idx_lists_travel_start_date
  ON public.lists (travel_start_date)
  WHERE travel_start_date IS NOT NULL;

CREATE INDEX IF NOT EXISTS idx_lists_travel_end_date
  ON public.lists (travel_end_date)
  WHERE travel_end_date IS NOT NULL;
