BEGIN;

-- Harden maintain_gift_details to better merge incoming gift fields and preserve/refresh rating/priority.
CREATE OR REPLACE FUNCTION maintain_gift_details()
RETURNS TRIGGER AS $$
DECLARE
    list_type_val text;
    gift_detail_uuid uuid;
    source_data jsonb;
    new_quantity integer;
    new_rating integer;
    new_where_to_buy text;
    new_amazon_url text;
    new_web_link text;
    existing_details gift_details%ROWTYPE;
BEGIN
    -- Check if this item belongs to a gift list
    SELECT l.list_type INTO list_type_val
    FROM lists l
    WHERE l.id = NEW.list_id;

    -- Only proceed if it's a gift list (support both singular/plural)
    IF list_type_val IN ('gift', 'gifts') THEN
        -- Determine source data: api_metadata > custom_fields
        source_data := COALESCE(NEW.api_metadata, NEW.custom_fields, '{}'::jsonb);

        -- Pull existing details to avoid losing previous values when not present in the payload
        IF NEW.gift_detail_id IS NOT NULL THEN
            SELECT * INTO existing_details FROM gift_details WHERE id = NEW.gift_detail_id;
        END IF;

        -- Extract values
        new_quantity := COALESCE(
            (source_data->>'quantity')::integer,
            existing_details.quantity
        );

        -- Rating falls back to priority when rating not provided; also preserve existing if nothing new
        new_rating := COALESCE(
            (source_data->>'rating')::integer,
            NEW.priority,
            existing_details.rating
        );

        new_where_to_buy := COALESCE(
            source_data->>'whereToBuy',
            source_data->>'where_to_buy',
            existing_details.where_to_buy
        );

        new_amazon_url := COALESCE(
            source_data->>'amazonUrl',
            source_data->>'amazon_url',
            existing_details.amazon_url
        );

        new_web_link := COALESCE(
            source_data->>'webLink',
            source_data->>'web_link',
            existing_details.web_link
        );

        -- Scenario 1: gift_detail_id already exists -> UPDATE
        IF NEW.gift_detail_id IS NOT NULL THEN
            UPDATE gift_details
            SET
                quantity = new_quantity,
                where_to_buy = new_where_to_buy,
                amazon_url = new_amazon_url,
                web_link = new_web_link,
                rating = new_rating,
                updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW.gift_detail_id;

            -- If no row was updated (e.g. it was deleted), treat as missing
            IF NOT FOUND THEN
                INSERT INTO gift_details (
                    id, list_item_id, quantity, where_to_buy, amazon_url, web_link, rating, created_at, updated_at
                ) VALUES (
                    NEW.gift_detail_id, NEW.id, new_quantity, new_where_to_buy, new_amazon_url, new_web_link, new_rating, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                );
            END IF;

        -- Scenario 2: gift_detail_id is NULL -> INSERT
        ELSE
            gift_detail_uuid := gen_random_uuid();

            INSERT INTO gift_details (
                id, list_item_id, quantity, where_to_buy, amazon_url, web_link, rating, created_at, updated_at
            ) VALUES (
                gift_detail_uuid, NEW.id, new_quantity, new_where_to_buy, new_amazon_url, new_web_link, new_rating, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
            );

            -- Update the list_item with the new FK
            NEW.gift_detail_id := gift_detail_uuid;
        END IF;

        -- Keep api_metadata in sync with the latest gift fields
        NEW.api_metadata := jsonb_strip_nulls(
            COALESCE(NEW.api_metadata, '{}'::jsonb) ||
            jsonb_build_object(
                'quantity', new_quantity,
                'where_to_buy', new_where_to_buy,
                'whereToBuy', new_where_to_buy,
                'amazon_url', new_amazon_url,
                'amazonUrl', new_amazon_url,
                'web_link', new_web_link,
                'webLink', new_web_link,
                'rating', new_rating
            )
        );
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

-- Drop the old trigger if it exists
DROP TRIGGER IF EXISTS auto_create_gift_details ON list_items;
DROP TRIGGER IF EXISTS maintain_gift_details_trigger ON list_items;

-- Create the refreshed trigger
CREATE TRIGGER maintain_gift_details_trigger
    BEFORE INSERT OR UPDATE ON list_items
    FOR EACH ROW
    EXECUTE FUNCTION maintain_gift_details();

COMMIT;
