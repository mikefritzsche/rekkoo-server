-- Create trigger to maintain movie_details and movie_detail_id on list_items
-- Ensures movie_detail_id is populated for movie list items and movie_details row exists

CREATE OR REPLACE FUNCTION maintain_movie_details()
RETURNS TRIGGER AS $$
DECLARE
    list_type_val text;
    movie_detail_uuid uuid;
    existing_movie_detail_id uuid;
BEGIN
    SELECT l.list_type INTO list_type_val
    FROM lists l
    WHERE l.id = NEW.list_id;

    IF list_type_val IS NULL THEN
        RETURN NEW;
    END IF;

    IF lower(list_type_val) NOT IN ('movie', 'movies') THEN
        RETURN NEW;
    END IF;

    IF NEW.movie_detail_id IS NULL AND (
        NEW.book_detail_id IS NOT NULL OR
        NEW.place_detail_id IS NOT NULL OR
        NEW.spotify_item_detail_id IS NOT NULL OR
        NEW.tv_detail_id IS NOT NULL OR
        NEW.recipe_detail_id IS NOT NULL OR
        NEW.gift_detail_id IS NOT NULL OR
        NEW.checklist_detail_id IS NOT NULL OR
        NEW.packing_detail_id IS NOT NULL
    ) THEN
        RETURN NEW;
    END IF;

    IF NEW.movie_detail_id IS NOT NULL THEN
        UPDATE movie_details
        SET
            title = COALESCE(movie_details.title, NEW.title),
            overview = COALESCE(movie_details.overview, NEW.description),
            updated_at = CURRENT_TIMESTAMP
        WHERE id = NEW.movie_detail_id;

        IF NOT FOUND THEN
            INSERT INTO movie_details (
                id, list_item_id, title, overview, created_at, updated_at
            ) VALUES (
                NEW.movie_detail_id, NEW.id, NEW.title, NEW.description, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            );
        END IF;

        RETURN NEW;
    END IF;

    SELECT id INTO existing_movie_detail_id
    FROM movie_details
    WHERE list_item_id = NEW.id
    LIMIT 1;

    IF existing_movie_detail_id IS NOT NULL THEN
        NEW.movie_detail_id := existing_movie_detail_id;
        RETURN NEW;
    END IF;

    movie_detail_uuid := gen_random_uuid();

    INSERT INTO movie_details (
        id, list_item_id, title, overview, created_at, updated_at
    ) VALUES (
        movie_detail_uuid, NEW.id, NEW.title, NEW.description, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
    );

    NEW.movie_detail_id := movie_detail_uuid;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS maintain_movie_details_trigger ON list_items;

CREATE TRIGGER maintain_movie_details_trigger
    BEFORE INSERT OR UPDATE ON list_items
    FOR EACH ROW
    EXECUTE FUNCTION maintain_movie_details();
