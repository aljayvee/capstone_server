-- Fast Food and Pharmacy carry no handling fee on an ordinary order.
--
-- The handling fee exists because a big basket is real shopping work and a real
-- float of company cash. Two meals from Jollibee or one box of paracetamol is
-- neither -- and charging a flat 50 pesos on a 176-peso fast-food order put the
-- fee at nearly a third of the goods.
--
-- NONE is not an absolute exemption. Past the size gate in pricingStrategy.ts
-- (more than 12 units, or 1,000 pesos) these categories price like any other,
-- because a twenty-item office lunch run is exactly the shopping this fee is for.
--
-- Supermarket & Grocery keeps PERCENT and Retail keeps THRESHOLD: the ordinary
-- order from those IS a shop.
UPDATE `merchant_categories`
SET `handlingFeeMode` = 'NONE'
WHERE `name` IN ('Fast Food & Restaurant', 'Pharmacy & Health');
