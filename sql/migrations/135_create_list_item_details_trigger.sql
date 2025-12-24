-- Create trigger to maintain detail tables for list_items
-- Handles movie, book, place, tv, recipe, checklist, packing, and spotify detail ids
-- Gift details are handled by maintain_gift_details_trigger

CREATE OR REPLACE FUNCTION maintain_list_item_details()
RETURNS TRIGGER AS $$
DECLARE
    list_type_val text;
    detail_uuid uuid;
    existing_detail_id uuid;
    spotify_id text;
    spotify_item_type text;
    source_data jsonb;
    raw_details jsonb;
    raw_tmdb jsonb;
    genres_list text[];
    tmdb_id_val text;
    tagline_val text;
    release_date_val date;
    rating_val numeric;
    vote_count_val integer;
    runtime_val integer;
    original_language_val text;
    original_title_val text;
    popularity_val numeric;
    poster_path_val text;
    backdrop_path_val text;
    budget_val bigint;
    revenue_val bigint;
    status_val text;
    production_companies_val jsonb;
    production_countries_val jsonb;
    spoken_languages_val jsonb;
    watch_providers_val jsonb;
    overview_val text;
    title_val text;
    book_source jsonb;
    book_raw jsonb;
    book_volume jsonb;
    book_google_id text;
    book_authors text[];
    book_publisher text;
    book_published_date text;
    book_page_count integer;
    book_isbn_13 text;
    book_isbn_10 text;
    book_categories text[];
    book_avg_rating numeric;
    book_ratings_count integer;
    book_language text;
    book_info_link text;
    book_canonical_link text;
    place_source jsonb;
    place_raw jsonb;
    place_result jsonb;
    place_location jsonb;
    place_google_id text;
    place_address_formatted text;
    place_address_components jsonb;
    place_phone_international text;
    place_phone_national text;
    place_website text;
    place_rating numeric;
    place_user_ratings_total integer;
    place_price_level integer;
    place_latitude double precision;
    place_longitude double precision;
    place_maps_url text;
    place_business_status text;
    place_opening_hours jsonb;
    place_types text[];
    place_photos text[];
    spotify_raw jsonb;
    spotify_images jsonb;
    spotify_external_urls jsonb;
    spotify_uri text;
    spotify_name text;
    spotify_item_metadata jsonb;
BEGIN
    IF NEW.list_id IS NULL THEN
        RETURN NEW;
    END IF;

    SELECT l.list_type INTO list_type_val
    FROM lists l
    WHERE l.id = NEW.list_id;

    IF list_type_val IS NULL THEN
        RETURN NEW;
    END IF;

    list_type_val := lower(list_type_val);

    -- Gift details are handled elsewhere.
    IF list_type_val IN ('gift', 'gifts') THEN
        RETURN NEW;
    END IF;

    IF list_type_val IN ('movie', 'movies', 'moviestv', 'movies_tv', 'movie_tv') THEN
        IF NEW.book_detail_id IS NOT NULL OR
           NEW.place_detail_id IS NOT NULL OR
           NEW.spotify_item_detail_id IS NOT NULL OR
           NEW.tv_detail_id IS NOT NULL OR
           NEW.recipe_detail_id IS NOT NULL OR
           NEW.gift_detail_id IS NOT NULL OR
           NEW.checklist_detail_id IS NOT NULL OR
           NEW.packing_detail_id IS NOT NULL THEN
            RETURN NEW;
        END IF;

        source_data := COALESCE(NEW.api_metadata, NEW.custom_fields, '{}'::jsonb);
        raw_details := COALESCE(source_data->'raw_details', source_data->'raw', source_data);
        raw_tmdb := CASE
            WHEN raw_details ? 'raw' AND jsonb_typeof(raw_details->'raw') = 'object'
                THEN raw_details->'raw'
            ELSE raw_details
        END;

        title_val := COALESCE(raw_tmdb->>'title', raw_tmdb->>'name', NEW.title);
        overview_val := COALESCE(raw_tmdb->>'overview', source_data->>'description', NEW.description);
        tmdb_id_val := COALESCE(source_data->>'source_id', source_data->>'tmdb_id', raw_tmdb->>'id', raw_details->>'tmdb_id');
        tagline_val := COALESCE(raw_tmdb->>'tagline', raw_details->>'tmdb_tagline', source_data->>'tagline');
        status_val := COALESCE(raw_tmdb->>'status', raw_details->>'tmdb_status', source_data->>'status');
        poster_path_val := COALESCE(raw_tmdb->>'poster_path', raw_details->>'tmdb_poster_path');
        backdrop_path_val := COALESCE(raw_tmdb->>'backdrop_path', raw_details->>'tmdb_backdrop_path');
        original_language_val := COALESCE(raw_tmdb->>'original_language', raw_details->>'tmdb_original_language', source_data->>'original_language');
        original_title_val := COALESCE(raw_tmdb->>'original_title', raw_details->>'tmdb_original_title', source_data->>'original_title');
        production_companies_val := COALESCE(raw_tmdb->'production_companies', raw_details->'production_companies', source_data->'production_companies');
        production_countries_val := COALESCE(raw_tmdb->'production_countries', raw_details->'production_countries', source_data->'production_countries');
        spoken_languages_val := COALESCE(raw_tmdb->'spoken_languages', raw_details->'spoken_languages', raw_details->'tmdb_spoken_languages', source_data->'spoken_languages');
        watch_providers_val := COALESCE(
            raw_tmdb->'watch_providers',
            raw_tmdb->'watch/providers',
            raw_details->'watch_providers',
            raw_details->'watch/providers',
            source_data->'watch_providers'
        );

        IF raw_tmdb ? 'genres' AND jsonb_typeof(raw_tmdb->'genres') = 'array' THEN
            SELECT array_agg(elem->>'name')
            INTO genres_list
            FROM jsonb_array_elements(raw_tmdb->'genres') AS elem;
        END IF;

        rating_val := CASE
            WHEN raw_tmdb->>'vote_average' ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN round((raw_tmdb->>'vote_average')::numeric, 1)
            WHEN source_data->>'rating' ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN round((source_data->>'rating')::numeric, 1)
            ELSE NULL
        END;

        vote_count_val := CASE
            WHEN raw_tmdb->>'vote_count' ~ '^[0-9]+$'
                THEN (raw_tmdb->>'vote_count')::integer
            WHEN source_data->>'vote_count' ~ '^[0-9]+$'
                THEN (source_data->>'vote_count')::integer
            ELSE NULL
        END;

        runtime_val := CASE
            WHEN raw_tmdb->>'runtime' ~ '^[0-9]+$'
                THEN (raw_tmdb->>'runtime')::integer
            WHEN raw_tmdb->>'runtime_minutes' ~ '^[0-9]+$'
                THEN (raw_tmdb->>'runtime_minutes')::integer
            WHEN source_data->>'runtime' ~ '^[0-9]+$'
                THEN (source_data->>'runtime')::integer
            WHEN source_data->>'runtime_minutes' ~ '^[0-9]+$'
                THEN (source_data->>'runtime_minutes')::integer
            ELSE NULL
        END;

        popularity_val := CASE
            WHEN raw_tmdb->>'popularity' ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN (raw_tmdb->>'popularity')::numeric
            WHEN source_data->>'popularity' ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN (source_data->>'popularity')::numeric
            ELSE NULL
        END;

        budget_val := CASE
            WHEN raw_tmdb->>'budget' ~ '^[0-9]+$'
                THEN (raw_tmdb->>'budget')::bigint
            WHEN source_data->>'budget' ~ '^[0-9]+$'
                THEN (source_data->>'budget')::bigint
            ELSE NULL
        END;

        revenue_val := CASE
            WHEN raw_tmdb->>'revenue' ~ '^[0-9]+$'
                THEN (raw_tmdb->>'revenue')::bigint
            WHEN source_data->>'revenue' ~ '^[0-9]+$'
                THEN (source_data->>'revenue')::bigint
            ELSE NULL
        END;

        release_date_val := CASE
            WHEN raw_tmdb->>'release_date' ~ '^\\d{4}-\\d{2}-\\d{2}$'
                THEN (raw_tmdb->>'release_date')::date
            WHEN raw_details->>'release_date' ~ '^\\d{4}-\\d{2}-\\d{2}$'
                THEN (raw_details->>'release_date')::date
            WHEN raw_details->>'tmdb_release_date' ~ '^\\d{4}-\\d{2}-\\d{2}$'
                THEN (raw_details->>'tmdb_release_date')::date
            WHEN source_data->>'release_date' ~ '^\\d{4}-\\d{2}-\\d{2}$'
                THEN (source_data->>'release_date')::date
            ELSE NULL
        END;

        IF NEW.movie_detail_id IS NOT NULL THEN
            UPDATE movie_details
            SET
                tmdb_id = COALESCE(tmdb_id_val, movie_details.tmdb_id),
                tagline = COALESCE(tagline_val, movie_details.tagline),
                release_date = COALESCE(release_date_val, movie_details.release_date),
                genres = COALESCE(genres_list, movie_details.genres),
                rating = COALESCE(rating_val, movie_details.rating),
                vote_count = COALESCE(vote_count_val, movie_details.vote_count),
                runtime_minutes = COALESCE(runtime_val, movie_details.runtime_minutes),
                original_language = COALESCE(original_language_val, movie_details.original_language),
                original_title = COALESCE(original_title_val, movie_details.original_title),
                popularity = COALESCE(popularity_val, movie_details.popularity),
                poster_path = COALESCE(poster_path_val, movie_details.poster_path),
                backdrop_path = COALESCE(backdrop_path_val, movie_details.backdrop_path),
                budget = COALESCE(budget_val, movie_details.budget),
                revenue = COALESCE(revenue_val, movie_details.revenue),
                status = COALESCE(status_val, movie_details.status),
                production_companies = COALESCE(production_companies_val, movie_details.production_companies),
                production_countries = COALESCE(production_countries_val, movie_details.production_countries),
                spoken_languages = COALESCE(spoken_languages_val, movie_details.spoken_languages),
                watch_providers = COALESCE(watch_providers_val, movie_details.watch_providers),
                title = COALESCE(title_val, movie_details.title),
                overview = COALESCE(overview_val, movie_details.overview),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW.movie_detail_id;

            IF NOT FOUND THEN
                INSERT INTO movie_details (
                    id,
                    list_item_id,
                    tmdb_id,
                    tagline,
                    release_date,
                    genres,
                    rating,
                    vote_count,
                    runtime_minutes,
                    original_language,
                    original_title,
                    popularity,
                    poster_path,
                    backdrop_path,
                    budget,
                    revenue,
                    status,
                    production_companies,
                    production_countries,
                    spoken_languages,
                    watch_providers,
                    title,
                    overview,
                    created_at,
                    updated_at
                ) VALUES (
                    NEW.movie_detail_id,
                    NEW.id,
                    tmdb_id_val,
                    tagline_val,
                    release_date_val,
                    genres_list,
                    rating_val,
                    vote_count_val,
                    runtime_val,
                    original_language_val,
                    original_title_val,
                    popularity_val,
                    poster_path_val,
                    backdrop_path_val,
                    budget_val,
                    revenue_val,
                    status_val,
                    production_companies_val,
                    production_countries_val,
                    spoken_languages_val,
                    watch_providers_val,
                    title_val,
                    overview_val,
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP
                );
            END IF;

            RETURN NEW;
        END IF;

        SELECT id INTO existing_detail_id
        FROM movie_details
        WHERE list_item_id = NEW.id
        LIMIT 1;

        IF existing_detail_id IS NOT NULL THEN
            NEW.movie_detail_id := existing_detail_id;
            RETURN NEW;
        END IF;

        detail_uuid := gen_random_uuid();

        INSERT INTO movie_details (
            id,
            list_item_id,
            tmdb_id,
            tagline,
            release_date,
            genres,
            rating,
            vote_count,
            runtime_minutes,
            original_language,
            original_title,
            popularity,
            poster_path,
            backdrop_path,
            budget,
            revenue,
            status,
            production_companies,
            production_countries,
            spoken_languages,
            watch_providers,
            title,
            overview,
            created_at,
            updated_at
        ) VALUES (
            detail_uuid,
            NEW.id,
            tmdb_id_val,
            tagline_val,
            release_date_val,
            genres_list,
            rating_val,
            vote_count_val,
            runtime_val,
            original_language_val,
            original_title_val,
            popularity_val,
            poster_path_val,
            backdrop_path_val,
            budget_val,
            revenue_val,
            status_val,
            production_companies_val,
            production_countries_val,
            spoken_languages_val,
            watch_providers_val,
            title_val,
            overview_val,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        );

        NEW.movie_detail_id := detail_uuid;

        RETURN NEW;
    END IF;

    IF list_type_val IN ('book', 'books') THEN
        IF NEW.movie_detail_id IS NOT NULL OR
           NEW.place_detail_id IS NOT NULL OR
           NEW.spotify_item_detail_id IS NOT NULL OR
           NEW.tv_detail_id IS NOT NULL OR
           NEW.recipe_detail_id IS NOT NULL OR
           NEW.gift_detail_id IS NOT NULL OR
           NEW.checklist_detail_id IS NOT NULL OR
           NEW.packing_detail_id IS NOT NULL THEN
            RETURN NEW;
        END IF;

        book_source := COALESCE(NEW.api_metadata, NEW.custom_fields, '{}'::jsonb);
        book_raw := COALESCE(book_source->'raw_details', book_source->'raw', book_source);
        book_volume := CASE
            WHEN book_raw ? 'raw' AND jsonb_typeof(book_raw->'raw') = 'object'
                THEN book_raw->'raw'->'volumeInfo'
            ELSE book_raw->'volumeInfo'
        END;

        book_google_id := COALESCE(
            book_source->>'source_id',
            book_source->>'id',
            book_raw->>'id',
            NEW.item_id_from_api
        );

        book_publisher := COALESCE(book_source->>'publisher', book_volume->>'publisher');
        book_published_date := COALESCE(book_source->>'publishDate', book_volume->>'publishedDate');
        book_language := COALESCE(book_source->>'language', book_volume->>'language');
        book_info_link := COALESCE(book_source->>'infoLink', book_volume->>'infoLink', book_source->>'previewLink');
        book_canonical_link := COALESCE(book_source->>'canonicalVolumeLink', book_volume->>'canonicalVolumeLink');

        IF book_volume ? 'authors' AND jsonb_typeof(book_volume->'authors') = 'array' THEN
            SELECT array_agg(elem::text)
            INTO book_authors
            FROM jsonb_array_elements_text(book_volume->'authors') AS elem;
        ELSIF book_source ? 'authors' AND jsonb_typeof(book_source->'authors') = 'array' THEN
            SELECT array_agg(elem::text)
            INTO book_authors
            FROM jsonb_array_elements_text(book_source->'authors') AS elem;
        END IF;

        IF book_volume ? 'categories' AND jsonb_typeof(book_volume->'categories') = 'array' THEN
            SELECT array_agg(elem::text)
            INTO book_categories
            FROM jsonb_array_elements_text(book_volume->'categories') AS elem;
        END IF;

        book_page_count := CASE
            WHEN book_source->>'pages' ~ '^[0-9]+$'
                THEN (book_source->>'pages')::integer
            WHEN book_volume->>'pageCount' ~ '^[0-9]+$'
                THEN (book_volume->>'pageCount')::integer
            WHEN book_volume->>'printedPageCount' ~ '^[0-9]+$'
                THEN (book_volume->>'printedPageCount')::integer
            ELSE NULL
        END;

        book_avg_rating := CASE
            WHEN book_source->>'rating' ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN (book_source->>'rating')::numeric
            WHEN book_volume->>'averageRating' ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN (book_volume->>'averageRating')::numeric
            ELSE NULL
        END;

        book_ratings_count := CASE
            WHEN book_volume->>'ratingsCount' ~ '^[0-9]+$'
                THEN (book_volume->>'ratingsCount')::integer
            WHEN book_source->>'ratingsCount' ~ '^[0-9]+$'
                THEN (book_source->>'ratingsCount')::integer
            ELSE NULL
        END;

        IF book_volume ? 'industryIdentifiers' AND jsonb_typeof(book_volume->'industryIdentifiers') = 'array' THEN
            SELECT
                MAX(CASE WHEN elem->>'type' = 'ISBN_13' THEN elem->>'identifier' END),
                MAX(CASE WHEN elem->>'type' = 'ISBN_10' THEN elem->>'identifier' END)
            INTO book_isbn_13, book_isbn_10
            FROM jsonb_array_elements(book_volume->'industryIdentifiers') AS elem;
        END IF;

        IF NEW.book_detail_id IS NOT NULL THEN
            UPDATE book_details
            SET
                google_book_id = COALESCE(book_google_id, book_details.google_book_id),
                authors = COALESCE(book_authors, book_details.authors),
                publisher = COALESCE(book_publisher, book_details.publisher),
                published_date = COALESCE(book_published_date, book_details.published_date),
                page_count = COALESCE(book_page_count, book_details.page_count),
                isbn_13 = COALESCE(book_isbn_13, book_details.isbn_13),
                isbn_10 = COALESCE(book_isbn_10, book_details.isbn_10),
                categories = COALESCE(book_categories, book_details.categories),
                average_rating_google = COALESCE(book_avg_rating, book_details.average_rating_google),
                ratings_count_google = COALESCE(book_ratings_count, book_details.ratings_count_google),
                language = COALESCE(book_language, book_details.language),
                info_link = COALESCE(book_info_link, book_details.info_link),
                canonical_volume_link = COALESCE(book_canonical_link, book_details.canonical_volume_link),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW.book_detail_id;

            IF NOT FOUND THEN
                INSERT INTO book_details (
                    id,
                    list_item_id,
                    google_book_id,
                    authors,
                    publisher,
                    published_date,
                    page_count,
                    isbn_13,
                    isbn_10,
                    categories,
                    average_rating_google,
                    ratings_count_google,
                    language,
                    info_link,
                    canonical_volume_link,
                    created_at,
                    updated_at
                ) VALUES (
                    NEW.book_detail_id,
                    NEW.id,
                    book_google_id,
                    book_authors,
                    book_publisher,
                    book_published_date,
                    book_page_count,
                    book_isbn_13,
                    book_isbn_10,
                    book_categories,
                    book_avg_rating,
                    book_ratings_count,
                    book_language,
                    book_info_link,
                    book_canonical_link,
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP
                );
            END IF;

            RETURN NEW;
        END IF;

        SELECT id INTO existing_detail_id
        FROM book_details
        WHERE list_item_id = NEW.id
        LIMIT 1;

        IF existing_detail_id IS NOT NULL THEN
            NEW.book_detail_id := existing_detail_id;
            RETURN NEW;
        END IF;

        detail_uuid := gen_random_uuid();

        INSERT INTO book_details (
            id,
            list_item_id,
            google_book_id,
            authors,
            publisher,
            published_date,
            page_count,
            isbn_13,
            isbn_10,
            categories,
            average_rating_google,
            ratings_count_google,
            language,
            info_link,
            canonical_volume_link,
            created_at,
            updated_at
        ) VALUES (
            detail_uuid,
            NEW.id,
            book_google_id,
            book_authors,
            book_publisher,
            book_published_date,
            book_page_count,
            book_isbn_13,
            book_isbn_10,
            book_categories,
            book_avg_rating,
            book_ratings_count,
            book_language,
            book_info_link,
            book_canonical_link,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        );

        NEW.book_detail_id := detail_uuid;

        RETURN NEW;
    END IF;

    IF list_type_val IN ('place', 'places') THEN
        IF NEW.movie_detail_id IS NOT NULL OR
           NEW.book_detail_id IS NOT NULL OR
           NEW.spotify_item_detail_id IS NOT NULL OR
           NEW.tv_detail_id IS NOT NULL OR
           NEW.recipe_detail_id IS NOT NULL OR
           NEW.gift_detail_id IS NOT NULL OR
           NEW.checklist_detail_id IS NOT NULL OR
           NEW.packing_detail_id IS NOT NULL THEN
            RETURN NEW;
        END IF;

        place_source := COALESCE(NEW.api_metadata, NEW.custom_fields, '{}'::jsonb);
        place_raw := COALESCE(place_source->'raw_details', place_source->'rawDetails', place_source->'raw', place_source);
        place_result := CASE
            WHEN place_raw ? 'result' AND jsonb_typeof(place_raw->'result') = 'object'
                THEN place_raw->'result'
            WHEN place_raw ? 'parsedPlace' AND jsonb_typeof(place_raw->'parsedPlace') = 'object'
                THEN place_raw->'parsedPlace'
            ELSE place_raw
        END;

        place_location := COALESCE(
            place_result->'geometry'->'location',
            place_result->'location',
            place_source->'geometry'->'location',
            place_source->'location'
        );

        place_google_id := COALESCE(
            place_source->>'source_id',
            place_source->>'place_id',
            place_result->>'place_id',
            place_result->>'placeId',
            NEW.item_id_from_api
        );

        place_address_formatted := COALESCE(
            place_result->>'formatted_address',
            place_result->>'formattedAddress',
            place_result->>'vicinity',
            place_source->>'address'
        );

        place_address_components := COALESCE(
            place_result->'address_components',
            place_result->'addressComponents',
            place_result->'adrAddress'
        );

        place_phone_national := COALESCE(
            place_result->>'formatted_phone_number',
            place_result->>'phoneNumber'
        );

        place_phone_international := COALESCE(
            place_result->>'international_phone_number',
            place_result->>'internationalPhoneNumber'
        );

        place_website := COALESCE(place_result->>'website', place_source->>'website');
        place_maps_url := COALESCE(place_result->>'url', place_result->>'googleMapsUrl');
        place_business_status := COALESCE(place_result->>'business_status', place_result->>'businessStatus');

        place_rating := CASE
            WHEN place_result->>'rating' ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN (place_result->>'rating')::numeric
            WHEN place_source->>'rating' ~ '^[0-9]+(\\.[0-9]+)?$'
                THEN (place_source->>'rating')::numeric
            ELSE NULL
        END;

        place_user_ratings_total := CASE
            WHEN place_result->>'user_ratings_total' ~ '^[0-9]+$'
                THEN (place_result->>'user_ratings_total')::integer
            WHEN place_result->>'userRatingsTotal' ~ '^[0-9]+$'
                THEN (place_result->>'userRatingsTotal')::integer
            ELSE NULL
        END;

        place_price_level := CASE
            WHEN place_result->>'price_level' ~ '^[0-9]+$'
                THEN (place_result->>'price_level')::integer
            WHEN place_result->>'priceLevel' ~ '^[0-9]+$'
                THEN (place_result->>'priceLevel')::integer
            ELSE NULL
        END;

        place_latitude := CASE
            WHEN place_location->>'lat' ~ '^-?[0-9]+(\\.[0-9]+)?$'
                THEN (place_location->>'lat')::double precision
            ELSE NULL
        END;

        place_longitude := CASE
            WHEN place_location->>'lng' ~ '^-?[0-9]+(\\.[0-9]+)?$'
                THEN (place_location->>'lng')::double precision
            ELSE NULL
        END;

        place_opening_hours := COALESCE(
            place_result->'opening_hours',
            place_result->'current_opening_hours',
            place_result->'hours'
        );

        IF place_result ? 'types' AND jsonb_typeof(place_result->'types') = 'array' THEN
            SELECT array_agg(elem::text)
            INTO place_types
            FROM jsonb_array_elements_text(place_result->'types') AS elem;
        END IF;

        IF place_result ? 'photos' AND jsonb_typeof(place_result->'photos') = 'array' THEN
            SELECT array_agg(
                COALESCE(
                    elem->>'photo_reference',
                    elem->>'url',
                    elem->>'photoUrl',
                    elem->>'photo_url'
                )
            )
            INTO place_photos
            FROM jsonb_array_elements(place_result->'photos') AS elem;
        END IF;

        IF NEW.place_detail_id IS NOT NULL THEN
            UPDATE place_details
            SET
                google_place_id = COALESCE(place_google_id, place_details.google_place_id),
                address_formatted = COALESCE(place_address_formatted, place_details.address_formatted),
                address_components = COALESCE(place_address_components, place_details.address_components),
                phone_number_international = COALESCE(place_phone_international, place_details.phone_number_international),
                phone_number_national = COALESCE(place_phone_national, place_details.phone_number_national),
                website = COALESCE(place_website, place_details.website),
                rating_google = COALESCE(place_rating, place_details.rating_google),
                user_ratings_total_google = COALESCE(place_user_ratings_total, place_details.user_ratings_total_google),
                price_level_google = COALESCE(place_price_level, place_details.price_level_google),
                latitude = COALESCE(place_latitude, place_details.latitude),
                longitude = COALESCE(place_longitude, place_details.longitude),
                google_maps_url = COALESCE(place_maps_url, place_details.google_maps_url),
                business_status = COALESCE(place_business_status, place_details.business_status),
                opening_hours = COALESCE(place_opening_hours, place_details.opening_hours),
                types = COALESCE(place_types, place_details.types),
                photos = COALESCE(place_photos, place_details.photos),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW.place_detail_id;

            IF NOT FOUND THEN
                INSERT INTO place_details (
                    id,
                    list_item_id,
                    google_place_id,
                    address_formatted,
                    address_components,
                    phone_number_international,
                    phone_number_national,
                    website,
                    rating_google,
                    user_ratings_total_google,
                    price_level_google,
                    latitude,
                    longitude,
                    google_maps_url,
                    business_status,
                    opening_hours,
                    types,
                    photos,
                    created_at,
                    updated_at
                ) VALUES (
                    NEW.place_detail_id,
                    NEW.id,
                    place_google_id,
                    place_address_formatted,
                    place_address_components,
                    place_phone_international,
                    place_phone_national,
                    place_website,
                    place_rating,
                    place_user_ratings_total,
                    place_price_level,
                    place_latitude,
                    place_longitude,
                    place_maps_url,
                    place_business_status,
                    place_opening_hours,
                    place_types,
                    place_photos,
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP
                );
            END IF;

            RETURN NEW;
        END IF;

        SELECT id INTO existing_detail_id
        FROM place_details
        WHERE list_item_id = NEW.id
        LIMIT 1;

        IF existing_detail_id IS NOT NULL THEN
            NEW.place_detail_id := existing_detail_id;
            RETURN NEW;
        END IF;

        detail_uuid := gen_random_uuid();

        INSERT INTO place_details (
            id,
            list_item_id,
            google_place_id,
            address_formatted,
            address_components,
            phone_number_international,
            phone_number_national,
            website,
            rating_google,
            user_ratings_total_google,
            price_level_google,
            latitude,
            longitude,
            google_maps_url,
            business_status,
            opening_hours,
            types,
            photos,
            created_at,
            updated_at
        ) VALUES (
            detail_uuid,
            NEW.id,
            place_google_id,
            place_address_formatted,
            place_address_components,
            place_phone_international,
            place_phone_national,
            place_website,
            place_rating,
            place_user_ratings_total,
            place_price_level,
            place_latitude,
            place_longitude,
            place_maps_url,
            place_business_status,
            place_opening_hours,
            place_types,
            place_photos,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        );

        NEW.place_detail_id := detail_uuid;

        RETURN NEW;
    END IF;

    IF list_type_val IN ('tv', 'television', 'tvshows', 'shows') THEN
        IF NEW.movie_detail_id IS NOT NULL OR
           NEW.book_detail_id IS NOT NULL OR
           NEW.place_detail_id IS NOT NULL OR
           NEW.spotify_item_detail_id IS NOT NULL OR
           NEW.recipe_detail_id IS NOT NULL OR
           NEW.gift_detail_id IS NOT NULL OR
           NEW.checklist_detail_id IS NOT NULL OR
           NEW.packing_detail_id IS NOT NULL THEN
            RETURN NEW;
        END IF;

        IF NEW.tv_detail_id IS NOT NULL THEN
            UPDATE tv_details
            SET
                overview = COALESCE(tv_details.overview, NEW.description),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW.tv_detail_id;

            IF NOT FOUND THEN
                INSERT INTO tv_details (
                    id, list_item_id, overview, created_at, updated_at
                ) VALUES (
                    NEW.tv_detail_id, NEW.id, NEW.description, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                );
            END IF;

            RETURN NEW;
        END IF;

        SELECT id INTO existing_detail_id
        FROM tv_details
        WHERE list_item_id = NEW.id
        LIMIT 1;

        IF existing_detail_id IS NOT NULL THEN
            NEW.tv_detail_id := existing_detail_id;
            RETURN NEW;
        END IF;

        detail_uuid := gen_random_uuid();

        INSERT INTO tv_details (
            id, list_item_id, overview, created_at, updated_at
        ) VALUES (
            detail_uuid, NEW.id, NEW.description, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );

        NEW.tv_detail_id := detail_uuid;

        RETURN NEW;
    END IF;

    IF list_type_val IN ('recipe', 'recipes') THEN
        IF NEW.movie_detail_id IS NOT NULL OR
           NEW.book_detail_id IS NOT NULL OR
           NEW.place_detail_id IS NOT NULL OR
           NEW.spotify_item_detail_id IS NOT NULL OR
           NEW.tv_detail_id IS NOT NULL OR
           NEW.gift_detail_id IS NOT NULL OR
           NEW.checklist_detail_id IS NOT NULL OR
           NEW.packing_detail_id IS NOT NULL THEN
            RETURN NEW;
        END IF;

        IF NEW.recipe_detail_id IS NOT NULL THEN
            UPDATE recipe_details
            SET
                title = COALESCE(recipe_details.title, NEW.title),
                summary = COALESCE(recipe_details.summary, NEW.description),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW.recipe_detail_id;

            IF NOT FOUND THEN
                INSERT INTO recipe_details (
                    id, list_item_id, title, summary, created_at, updated_at
                ) VALUES (
                    NEW.recipe_detail_id, NEW.id, NEW.title, NEW.description, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                );
            END IF;

            RETURN NEW;
        END IF;

        SELECT id INTO existing_detail_id
        FROM recipe_details
        WHERE list_item_id = NEW.id
        LIMIT 1;

        IF existing_detail_id IS NOT NULL THEN
            NEW.recipe_detail_id := existing_detail_id;
            RETURN NEW;
        END IF;

        detail_uuid := gen_random_uuid();

        INSERT INTO recipe_details (
            id, list_item_id, title, summary, created_at, updated_at
        ) VALUES (
            detail_uuid, NEW.id, NEW.title, NEW.description, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );

        NEW.recipe_detail_id := detail_uuid;

        RETURN NEW;
    END IF;

    IF list_type_val IN ('checklist', 'checklists') THEN
        IF NEW.movie_detail_id IS NOT NULL OR
           NEW.book_detail_id IS NOT NULL OR
           NEW.place_detail_id IS NOT NULL OR
           NEW.spotify_item_detail_id IS NOT NULL OR
           NEW.tv_detail_id IS NOT NULL OR
           NEW.recipe_detail_id IS NOT NULL OR
           NEW.gift_detail_id IS NOT NULL OR
           NEW.packing_detail_id IS NOT NULL THEN
            RETURN NEW;
        END IF;

        IF NEW.checklist_detail_id IS NOT NULL THEN
            UPDATE checklist_details
            SET updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW.checklist_detail_id;

            IF NOT FOUND THEN
                INSERT INTO checklist_details (
                    id, list_item_id, created_at, updated_at
                ) VALUES (
                    NEW.checklist_detail_id, NEW.id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                );
            END IF;

            RETURN NEW;
        END IF;

        SELECT id INTO existing_detail_id
        FROM checklist_details
        WHERE list_item_id = NEW.id
        LIMIT 1;

        IF existing_detail_id IS NOT NULL THEN
            NEW.checklist_detail_id := existing_detail_id;
            RETURN NEW;
        END IF;

        detail_uuid := gen_random_uuid();

        INSERT INTO checklist_details (
            id, list_item_id, created_at, updated_at
        ) VALUES (
            detail_uuid, NEW.id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );

        NEW.checklist_detail_id := detail_uuid;

        RETURN NEW;
    END IF;

    IF list_type_val IN ('packing', 'packings') THEN
        IF NEW.movie_detail_id IS NOT NULL OR
           NEW.book_detail_id IS NOT NULL OR
           NEW.place_detail_id IS NOT NULL OR
           NEW.spotify_item_detail_id IS NOT NULL OR
           NEW.tv_detail_id IS NOT NULL OR
           NEW.recipe_detail_id IS NOT NULL OR
           NEW.gift_detail_id IS NOT NULL OR
           NEW.checklist_detail_id IS NOT NULL THEN
            RETURN NEW;
        END IF;

        IF NEW.packing_detail_id IS NOT NULL THEN
            UPDATE packing_details
            SET updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW.packing_detail_id;

            IF NOT FOUND THEN
                INSERT INTO packing_details (
                    id, list_item_id, created_at, updated_at
                ) VALUES (
                    NEW.packing_detail_id, NEW.id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
                );
            END IF;

            RETURN NEW;
        END IF;

        SELECT id INTO existing_detail_id
        FROM packing_details
        WHERE list_item_id = NEW.id
        LIMIT 1;

        IF existing_detail_id IS NOT NULL THEN
            NEW.packing_detail_id := existing_detail_id;
            RETURN NEW;
        END IF;

        detail_uuid := gen_random_uuid();

        INSERT INTO packing_details (
            id, list_item_id, created_at, updated_at
        ) VALUES (
            detail_uuid, NEW.id, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP
        );

        NEW.packing_detail_id := detail_uuid;

        RETURN NEW;
    END IF;

    IF list_type_val IN ('music', 'spotify') THEN
        IF NEW.movie_detail_id IS NOT NULL OR
           NEW.book_detail_id IS NOT NULL OR
           NEW.place_detail_id IS NOT NULL OR
           NEW.tv_detail_id IS NOT NULL OR
           NEW.recipe_detail_id IS NOT NULL OR
           NEW.gift_detail_id IS NOT NULL OR
           NEW.checklist_detail_id IS NOT NULL OR
           NEW.packing_detail_id IS NOT NULL THEN
            RETURN NEW;
        END IF;

        spotify_id := COALESCE(
            NEW.api_metadata->>'spotify_id',
            NEW.api_metadata->'raw_details'->>'spotify_id',
            NEW.api_metadata->'raw_details'->>'id',
            NEW.api_metadata->'rawDetails'->>'spotify_id',
            NEW.api_metadata->'rawDetails'->>'id',
            NEW.api_metadata->>'id',
            NEW.item_id_from_api
        );

        spotify_item_type := COALESCE(
            NEW.api_metadata->>'spotify_item_type',
            NEW.api_metadata->'raw_details'->>'spotify_item_type',
            NEW.api_metadata->'raw_details'->>'type',
            NEW.api_metadata->'rawDetails'->>'spotify_item_type',
            NEW.api_metadata->'rawDetails'->>'type',
            NEW.api_metadata->>'type'
        );
        IF spotify_item_type IS NULL OR btrim(spotify_item_type) = '' THEN
            spotify_item_type := 'track';
        END IF;

        IF spotify_id IS NULL OR spotify_item_type IS NULL THEN
            RETURN NEW;
        END IF;

        spotify_raw := COALESCE(
            NEW.api_metadata->'raw_details',
            NEW.api_metadata->'rawDetails',
            NEW.api_metadata->'raw',
            NEW.api_metadata
        );
        spotify_name := COALESCE(spotify_raw->>'name', NEW.title);
        spotify_external_urls := COALESCE(spotify_raw->'external_urls', NEW.api_metadata->'external_urls');
        spotify_uri := COALESCE(spotify_raw->>'uri', NEW.api_metadata->>'uri');
        spotify_images := COALESCE(spotify_raw->'images', spotify_raw->'album'->'images', NEW.api_metadata->'images');
        spotify_item_metadata := COALESCE(spotify_raw, NEW.api_metadata);

        IF NEW.spotify_item_detail_id IS NOT NULL THEN
            UPDATE spotify_item_details
            SET
                name = COALESCE(spotify_name, spotify_item_details.name),
                external_urls_spotify = COALESCE(spotify_external_urls, spotify_item_details.external_urls_spotify),
                images = COALESCE(spotify_images, spotify_item_details.images),
                uri_spotify = COALESCE(spotify_uri, spotify_item_details.uri_spotify),
                item_specific_metadata = COALESCE(spotify_item_metadata, spotify_item_details.item_specific_metadata),
                updated_at = CURRENT_TIMESTAMP
            WHERE id = NEW.spotify_item_detail_id;

            IF NOT FOUND THEN
                INSERT INTO spotify_item_details (
                    id,
                    list_item_id,
                    spotify_id,
                    spotify_item_type,
                    name,
                    external_urls_spotify,
                    images,
                    uri_spotify,
                    item_specific_metadata,
                    created_at,
                    updated_at
                ) VALUES (
                    NEW.spotify_item_detail_id,
                    NEW.id,
                    spotify_id,
                    spotify_item_type,
                    spotify_name,
                    spotify_external_urls,
                    spotify_images,
                    spotify_uri,
                    spotify_item_metadata,
                    CURRENT_TIMESTAMP,
                    CURRENT_TIMESTAMP
                );
            END IF;

            RETURN NEW;
        END IF;

        SELECT id INTO existing_detail_id
        FROM spotify_item_details
        WHERE list_item_id = NEW.id
        LIMIT 1;

        IF existing_detail_id IS NOT NULL THEN
            NEW.spotify_item_detail_id := existing_detail_id;
            RETURN NEW;
        END IF;

        detail_uuid := gen_random_uuid();

        INSERT INTO spotify_item_details (
            id,
            list_item_id,
            spotify_id,
            spotify_item_type,
            name,
            external_urls_spotify,
            images,
            uri_spotify,
            item_specific_metadata,
            created_at,
            updated_at
        ) VALUES (
            detail_uuid,
            NEW.id,
            spotify_id,
            spotify_item_type,
            spotify_name,
            spotify_external_urls,
            spotify_images,
            spotify_uri,
            spotify_item_metadata,
            CURRENT_TIMESTAMP,
            CURRENT_TIMESTAMP
        );

        NEW.spotify_item_detail_id := detail_uuid;

        RETURN NEW;
    END IF;

    RETURN NEW;
END;
$$ LANGUAGE plpgsql;

DROP TRIGGER IF EXISTS maintain_movie_details_trigger ON list_items;
DROP TRIGGER IF EXISTS maintain_list_item_details_trigger ON list_items;

CREATE TRIGGER maintain_list_item_details_trigger
    BEFORE INSERT OR UPDATE ON list_items
    FOR EACH ROW
    EXECUTE FUNCTION maintain_list_item_details();
