-- Adds a 'tags' column to the 'list_items' table to store user-generated keywords.

ALTER TABLE public.list_items
ADD COLUMN tags TEXT[]; 