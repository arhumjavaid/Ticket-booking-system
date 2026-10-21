-- Data migration: introduce the PREMIUM seat tier.
-- Floor rows A-B stay VIP, Floor rows C+ become PREMIUM, everything else stays as-is.
UPDATE "seats" s
SET "seat_type" = 'PREMIUM'
FROM "venue_sections" vs
WHERE s."venue_section_id" = vs."id"
  AND vs."name" = 'Floor'
  AND s."seat_type" = 'VIP'
  AND s."row_label" > 'B';

-- Reprice still-available inventory to base_price x tier multiplier
-- (VIP 2, PREMIUM 1.5, REGULAR 1). Held/booked seats keep their price.
UPDATE "event_seats" es
SET "price" = ROUND(e."base_price" * CASE st."seat_type" WHEN 'VIP' THEN 2 WHEN 'PREMIUM' THEN 1.5 ELSE 1 END, 2)
FROM "events" e, "seats" st
WHERE es."event_id" = e."id"
  AND es."seat_id" = st."id"
  AND es."status" = 'AVAILABLE';
