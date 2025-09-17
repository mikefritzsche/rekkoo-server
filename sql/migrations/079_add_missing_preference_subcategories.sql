-- Migration: Add missing preference subcategories
-- Purpose: Add subcategories for Books, Travel, Food, Lifestyle, Creative, Knowledge, and Special Interests

BEGIN;

-- Insert Books & Reading subcategories
INSERT INTO public.preference_subcategories (category_id, name, slug, keywords)
SELECT id, subcat.name, subcat.slug, subcat.keywords
FROM public.preference_categories pc,
LATERAL (VALUES
    ('Fiction', 'fiction', ARRAY['fiction', 'novels', 'stories', 'literature']),
    ('Non-Fiction', 'non-fiction', ARRAY['non-fiction', 'nonfiction', 'factual', 'real']),
    ('Mystery & Thriller', 'mystery-thriller', ARRAY['mystery', 'thriller', 'detective', 'crime']),
    ('Science Fiction', 'sci-fi-books', ARRAY['sci-fi', 'science fiction', 'dystopian', 'future']),
    ('Fantasy', 'fantasy-books', ARRAY['fantasy', 'magic', 'dragons', 'epic fantasy']),
    ('Romance Novels', 'romance-novels', ARRAY['romance', 'love stories', 'romantic fiction']),
    ('Biography', 'biography', ARRAY['biography', 'autobiography', 'memoir', 'life story']),
    ('Self-Help', 'self-help', ARRAY['self-help', 'personal development', 'motivation']),
    ('History', 'history-books', ARRAY['history', 'historical', 'past events', 'historical fiction']),
    ('Poetry', 'poetry', ARRAY['poetry', 'poems', 'verse', 'haiku']),
    ('Comics & Graphic Novels', 'comics', ARRAY['comics', 'graphic novels', 'manga', 'comic books']),
    ('Cookbooks', 'cookbooks', ARRAY['cookbooks', 'recipes', 'cooking books', 'food books']),
    ('Children''s Books', 'childrens-books', ARRAY['children', 'kids books', 'picture books', 'young adult']),
    ('Business', 'business-books', ARRAY['business', 'entrepreneurship', 'management', 'leadership']),
    ('Philosophy', 'philosophy-books', ARRAY['philosophy', 'philosophical', 'ethics', 'thinking'])
) AS subcat(name, slug, keywords)
WHERE pc.slug = 'books' AND NOT EXISTS (
    SELECT 1 FROM public.preference_subcategories WHERE category_id = pc.id
);

-- Insert Travel & Places subcategories
INSERT INTO public.preference_subcategories (category_id, name, slug, keywords)
SELECT id, subcat.name, subcat.slug, subcat.keywords
FROM public.preference_categories pc,
LATERAL (VALUES
    ('Adventure Travel', 'adventure-travel', ARRAY['adventure', 'extreme', 'outdoor', 'wilderness']),
    ('Beach & Islands', 'beach-islands', ARRAY['beach', 'islands', 'tropical', 'seaside', 'ocean']),
    ('City Exploration', 'city-exploration', ARRAY['cities', 'urban', 'metropolis', 'downtown']),
    ('Cultural Tourism', 'cultural-tourism', ARRAY['culture', 'heritage', 'traditions', 'customs']),
    ('Road Trips', 'road-trips', ARRAY['road trip', 'driving', 'scenic routes', 'highways']),
    ('Backpacking', 'backpacking', ARRAY['backpacking', 'budget travel', 'hostels', 'gap year']),
    ('Luxury Travel', 'luxury-travel', ARRAY['luxury', 'premium', 'five star', 'resorts']),
    ('Camping & RV', 'camping-rv', ARRAY['camping', 'rv', 'outdoors', 'tent', 'campgrounds']),
    ('Cruises', 'cruises', ARRAY['cruise', 'ship', 'sailing', 'ocean liner']),
    ('Mountain & Ski', 'mountain-ski', ARRAY['mountains', 'skiing', 'snowboarding', 'alpine']),
    ('Historical Sites', 'historical-sites', ARRAY['historical', 'monuments', 'landmarks', 'unesco']),
    ('National Parks', 'national-parks', ARRAY['national parks', 'nature', 'wildlife', 'conservation']),
    ('Food Tourism', 'food-tourism', ARRAY['food travel', 'culinary', 'restaurants', 'local cuisine']),
    ('Photography Spots', 'photography-spots', ARRAY['photography', 'instagram', 'scenic', 'viewpoints']),
    ('Wellness Retreats', 'wellness-retreats', ARRAY['wellness', 'spa', 'retreat', 'relaxation'])
) AS subcat(name, slug, keywords)
WHERE pc.slug = 'travel' AND NOT EXISTS (
    SELECT 1 FROM public.preference_subcategories WHERE category_id = pc.id
);

-- Insert Food & Drink subcategories
INSERT INTO public.preference_subcategories (category_id, name, slug, keywords)
SELECT id, subcat.name, subcat.slug, subcat.keywords
FROM public.preference_categories pc,
LATERAL (VALUES
    ('Italian', 'italian-food', ARRAY['italian', 'pasta', 'pizza', 'mediterranean']),
    ('Asian Cuisine', 'asian-cuisine', ARRAY['asian', 'chinese', 'japanese', 'thai', 'korean']),
    ('Mexican', 'mexican-food', ARRAY['mexican', 'tacos', 'burritos', 'tex-mex']),
    ('American', 'american-food', ARRAY['american', 'burgers', 'bbq', 'southern']),
    ('French', 'french-food', ARRAY['french', 'french cuisine', 'bistro', 'patisserie']),
    ('Indian', 'indian-food', ARRAY['indian', 'curry', 'tandoori', 'masala']),
    ('Vegetarian', 'vegetarian', ARRAY['vegetarian', 'veggie', 'plant-based', 'meatless']),
    ('Vegan', 'vegan', ARRAY['vegan', 'plant-based', 'dairy-free', 'cruelty-free']),
    ('Seafood', 'seafood', ARRAY['seafood', 'fish', 'sushi', 'shellfish']),
    ('Desserts', 'desserts', ARRAY['desserts', 'sweets', 'cakes', 'pastries', 'chocolate']),
    ('Coffee & Tea', 'coffee-tea', ARRAY['coffee', 'tea', 'espresso', 'cafe', 'barista']),
    ('Craft Beer', 'craft-beer', ARRAY['beer', 'craft beer', 'brewery', 'ipa', 'ale']),
    ('Wine', 'wine', ARRAY['wine', 'vineyard', 'sommelier', 'red wine', 'white wine']),
    ('Cocktails', 'cocktails', ARRAY['cocktails', 'mixology', 'spirits', 'bartending']),
    ('Baking', 'baking', ARRAY['baking', 'bread', 'pastry', 'cakes', 'cookies'])
) AS subcat(name, slug, keywords)
WHERE pc.slug = 'food' AND NOT EXISTS (
    SELECT 1 FROM public.preference_subcategories WHERE category_id = pc.id
);

-- Insert Lifestyle subcategories
INSERT INTO public.preference_subcategories (category_id, name, slug, keywords)
SELECT id, subcat.name, subcat.slug, subcat.keywords
FROM public.preference_categories pc,
LATERAL (VALUES
    ('Fashion', 'fashion', ARRAY['fashion', 'style', 'clothing', 'trends', 'outfits']),
    ('Beauty', 'beauty', ARRAY['beauty', 'makeup', 'skincare', 'cosmetics', 'grooming']),
    ('Fitness', 'fitness', ARRAY['fitness', 'exercise', 'gym', 'workout', 'training']),
    ('Yoga', 'yoga', ARRAY['yoga', 'meditation', 'mindfulness', 'namaste', 'asana']),
    ('Home Decor', 'home-decor', ARRAY['home decor', 'interior design', 'furniture', 'decoration']),
    ('Gardening', 'gardening', ARRAY['gardening', 'plants', 'garden', 'landscaping', 'flowers']),
    ('Pets', 'pets', ARRAY['pets', 'dogs', 'cats', 'animals', 'pet care']),
    ('Parenting', 'parenting', ARRAY['parenting', 'kids', 'family', 'children', 'babies']),
    ('Dating', 'dating', ARRAY['dating', 'relationships', 'romance', 'singles', 'couples']),
    ('Wellness', 'wellness', ARRAY['wellness', 'health', 'mental health', 'self-care', 'mindfulness']),
    ('Minimalism', 'minimalism', ARRAY['minimalism', 'simple living', 'declutter', 'organize']),
    ('Sustainable Living', 'sustainable', ARRAY['sustainable', 'eco-friendly', 'green', 'zero waste']),
    ('Personal Finance', 'personal-finance', ARRAY['finance', 'money', 'investing', 'budgeting', 'savings']),
    ('Career Development', 'career', ARRAY['career', 'professional', 'job', 'networking', 'skills']),
    ('Spirituality', 'spirituality', ARRAY['spiritual', 'soul', 'meditation', 'consciousness'])
) AS subcat(name, slug, keywords)
WHERE pc.slug = 'lifestyle' AND NOT EXISTS (
    SELECT 1 FROM public.preference_subcategories WHERE category_id = pc.id
);

-- Insert Creative & Hobbies subcategories
INSERT INTO public.preference_subcategories (category_id, name, slug, keywords)
SELECT id, subcat.name, subcat.slug, subcat.keywords
FROM public.preference_categories pc,
LATERAL (VALUES
    ('Painting', 'painting', ARRAY['painting', 'art', 'canvas', 'oils', 'watercolor']),
    ('Photography', 'photography', ARRAY['photography', 'photos', 'camera', 'shooting', 'editing']),
    ('Writing', 'writing', ARRAY['writing', 'creative writing', 'blogging', 'journalism']),
    ('Music Production', 'music-production', ARRAY['music production', 'recording', 'mixing', 'beats']),
    ('Dancing', 'dancing', ARRAY['dancing', 'dance', 'ballet', 'hip hop', 'salsa']),
    ('Crafts', 'crafts', ARRAY['crafts', 'diy', 'handmade', 'crafting', 'scrapbooking']),
    ('Knitting & Sewing', 'knitting-sewing', ARRAY['knitting', 'sewing', 'crochet', 'embroidery']),
    ('Woodworking', 'woodworking', ARRAY['woodworking', 'carpentry', 'furniture', 'wood']),
    ('Pottery', 'pottery', ARRAY['pottery', 'ceramics', 'clay', 'sculpting']),
    ('Jewelry Making', 'jewelry', ARRAY['jewelry', 'beading', 'accessories', 'handmade jewelry']),
    ('Cooking Classes', 'cooking-classes', ARRAY['cooking class', 'culinary', 'chef', 'cuisine']),
    ('Acting', 'acting', ARRAY['acting', 'theater', 'drama', 'performance']),
    ('Film Making', 'film-making', ARRAY['filmmaking', 'video', 'directing', 'cinematography']),
    ('Digital Art', 'digital-art', ARRAY['digital art', 'graphic design', 'illustration', 'digital']),
    ('Collecting', 'collecting', ARRAY['collecting', 'collection', 'vintage', 'antiques'])
) AS subcat(name, slug, keywords)
WHERE pc.slug = 'creative' AND NOT EXISTS (
    SELECT 1 FROM public.preference_subcategories WHERE category_id = pc.id
);

-- Insert Knowledge & Growth subcategories
INSERT INTO public.preference_subcategories (category_id, name, slug, keywords)
SELECT id, subcat.name, subcat.slug, subcat.keywords
FROM public.preference_categories pc,
LATERAL (VALUES
    ('Science', 'science', ARRAY['science', 'scientific', 'research', 'experiments']),
    ('Technology', 'technology', ARRAY['technology', 'tech', 'computers', 'software', 'gadgets']),
    ('Psychology', 'psychology', ARRAY['psychology', 'mind', 'behavior', 'mental', 'therapy']),
    ('Philosophy', 'philosophy', ARRAY['philosophy', 'philosophical', 'thinking', 'wisdom']),
    ('Languages', 'languages', ARRAY['languages', 'language learning', 'linguistics', 'polyglot']),
    ('History', 'history', ARRAY['history', 'historical', 'past', 'ancient', 'modern history']),
    ('Politics', 'politics', ARRAY['politics', 'political', 'government', 'policy', 'elections']),
    ('Economics', 'economics', ARRAY['economics', 'economy', 'finance', 'markets', 'trade']),
    ('Environment', 'environment', ARRAY['environment', 'climate', 'ecology', 'conservation']),
    ('Space', 'space', ARRAY['space', 'astronomy', 'cosmos', 'planets', 'universe']),
    ('Medicine', 'medicine', ARRAY['medicine', 'medical', 'health', 'healthcare', 'biology']),
    ('Education', 'education', ARRAY['education', 'learning', 'teaching', 'academic', 'study']),
    ('Law', 'law', ARRAY['law', 'legal', 'justice', 'courts', 'legislation']),
    ('Mathematics', 'mathematics', ARRAY['math', 'mathematics', 'algebra', 'geometry', 'calculus']),
    ('Current Events', 'current-events', ARRAY['news', 'current events', 'world news', 'headlines'])
) AS subcat(name, slug, keywords)
WHERE pc.slug = 'knowledge' AND NOT EXISTS (
    SELECT 1 FROM public.preference_subcategories WHERE category_id = pc.id
);

-- Insert Special Interests subcategories
INSERT INTO public.preference_subcategories (category_id, name, slug, keywords)
SELECT id, subcat.name, subcat.slug, subcat.keywords
FROM public.preference_categories pc,
LATERAL (VALUES
    ('Sports', 'sports', ARRAY['sports', 'athletics', 'teams', 'competition', 'games']),
    ('Cars & Motorcycles', 'vehicles', ARRAY['cars', 'motorcycles', 'automotive', 'racing', 'bikes']),
    ('Board Games', 'board-games', ARRAY['board games', 'tabletop', 'strategy games', 'card games']),
    ('Outdoor Activities', 'outdoor', ARRAY['outdoor', 'hiking', 'camping', 'nature', 'adventure']),
    ('Vintage & Retro', 'vintage', ARRAY['vintage', 'retro', 'classic', 'antique', 'nostalgia']),
    ('Paranormal', 'paranormal', ARRAY['paranormal', 'supernatural', 'ghosts', 'mysteries', 'ufo']),
    ('True Crime', 'true-crime', ARRAY['true crime', 'crime', 'detective', 'investigation']),
    ('Comedy', 'comedy-interest', ARRAY['comedy', 'humor', 'stand-up', 'funny', 'jokes']),
    ('Astrology', 'astrology', ARRAY['astrology', 'zodiac', 'horoscope', 'stars', 'signs']),
    ('Anime & Manga', 'anime-manga', ARRAY['anime', 'manga', 'japanese culture', 'otaku']),
    ('Pop Culture', 'pop-culture', ARRAY['pop culture', 'trends', 'celebrities', 'entertainment news']),
    ('Social Media', 'social-media', ARRAY['social media', 'influencers', 'content creation', 'streaming']),
    ('Volunteering', 'volunteering', ARRAY['volunteering', 'charity', 'community service', 'helping']),
    ('Entrepreneurship', 'entrepreneurship', ARRAY['entrepreneur', 'startup', 'business', 'innovation']),
    ('Military & Defense', 'military', ARRAY['military', 'defense', 'armed forces', 'veterans'])
) AS subcat(name, slug, keywords)
WHERE pc.slug = 'special' AND NOT EXISTS (
    SELECT 1 FROM public.preference_subcategories WHERE category_id = pc.id
);

COMMIT;