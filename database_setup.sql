-- ============================================================================
-- Sugo Express Errand Management System - Complete MariaDB Database Schema DDL
-- Document Reference: Mobile-based_Errand_Service_System_Document_Polishing.docx
-- Database Engine: MariaDB / MySQL 8.0+ (InnoDB, utf8mb4)
-- Normalization Standard: 3rd Normal Form (3NF)
-- ============================================================================

CREATE DATABASE IF NOT EXISTS `errand_system_db` CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci;
USE `errand_system_db`;

-- ----------------------------------------------------------------------------
-- Table 1: Roles Lookup Table (roles_tbl)
-- ----------------------------------------------------------------------------
DROP TABLE IF EXISTS `pabili_details_tbl`;
DROP TABLE IF EXISTS `dispatch_logs`;
DROP TABLE IF EXISTS `errands`;
DROP TABLE IF EXISTS `addresses`;
DROP TABLE IF EXISTS `users`;
DROP TABLE IF EXISTS `barangays`;
DROP TABLE IF EXISTS `payment_modes`;
DROP TABLE IF EXISTS `merchant_categories`;
DROP TABLE IF EXISTS `roles_tbl`;
DROP TABLE IF EXISTS `rate_configs`;

CREATE TABLE `roles_tbl` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(50) NOT NULL UNIQUE,
  `description` VARCHAR(255) DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Table 2: Merchant Categories (merchant_categories)
-- ----------------------------------------------------------------------------
CREATE TABLE `merchant_categories` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) NOT NULL UNIQUE,
  `description` TEXT DEFAULT NULL,
  `merchant_count` INT NOT NULL DEFAULT 0,
  `status` ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Table 3: Payment Modes (payment_modes)
-- ----------------------------------------------------------------------------
CREATE TABLE `payment_modes` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) NOT NULL UNIQUE,
  `description` VARCHAR(255) DEFAULT NULL,
  `status` ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Table 4: Barangays Lookup Table (barangays)
-- ----------------------------------------------------------------------------
CREATE TABLE `barangays` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `name` VARCHAR(100) NOT NULL UNIQUE,
  `city` VARCHAR(100) NOT NULL DEFAULT 'Tacurong City',
  `province` VARCHAR(100) NOT NULL DEFAULT 'Sultan Kudarat'
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Table 5: System Users (users) - 3NF Atomic Attributes
-- ----------------------------------------------------------------------------
CREATE TABLE `users` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `username` VARCHAR(50) NOT NULL UNIQUE,
  `password_hash` VARCHAR(255) NOT NULL,
  `role` ENUM('OWNER', 'DISPATCHER', 'RIDER', 'CUSTOMER') NOT NULL,
  `first_name` VARCHAR(100) NOT NULL,
  `middle_name` VARCHAR(100) DEFAULT NULL,
  `last_name` VARCHAR(100) NOT NULL,
  `name` VARCHAR(200) NOT NULL,
  `email` VARCHAR(150) NOT NULL UNIQUE,
  `phone` VARCHAR(30) NOT NULL,
  `avatar` VARCHAR(255) DEFAULT NULL,
  `status` ENUM('Active', 'Inactive') NOT NULL DEFAULT 'Active',
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  INDEX `idx_users_role` (`role`),
  INDEX `idx_users_status` (`status`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Table 6: User Addresses (addresses)
-- ----------------------------------------------------------------------------
CREATE TABLE `addresses` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `user_id` INT NOT NULL,
  `street` VARCHAR(255) NOT NULL,
  `barangay_id` INT NOT NULL,
  `is_default` TINYINT(1) NOT NULL DEFAULT 0,
  FOREIGN KEY (`user_id`) REFERENCES `users` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`barangay_id`) REFERENCES `barangays` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Table 7: Errand Transactions (errands)
-- ----------------------------------------------------------------------------
CREATE TABLE `errands` (
  `id` VARCHAR(36) PRIMARY KEY,
  `category` VARCHAR(100) NOT NULL,
  `description` TEXT NOT NULL,
  `pickup_address` TEXT NOT NULL,
  `delivery_address` TEXT NOT NULL,
  `estimated_cost` DOUBLE NOT NULL DEFAULT 0,
  `delivery_fee` DOUBLE NOT NULL DEFAULT 50,
  `tip` DOUBLE NOT NULL DEFAULT 0,
  `total_cost` DOUBLE NOT NULL DEFAULT 50,
  `status` ENUM('PENDING', 'ASSIGNED', 'TRAVELING', 'AT_STORE', 'PURCHASED', 'EN_ROUTE', 'DELIVERED', 'COMPLETED', 'CANCELLED', 'DISPUTED') NOT NULL DEFAULT 'PENDING',
  `customer_id` INT NOT NULL,
  `rider_id` INT DEFAULT NULL,
  `payment_mode_id` INT DEFAULT NULL,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  FOREIGN KEY (`customer_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT,
  FOREIGN KEY (`rider_id`) REFERENCES `users` (`id`) ON DELETE SET NULL,
  FOREIGN KEY (`payment_mode_id`) REFERENCES `payment_modes` (`id`) ON DELETE SET NULL,
  INDEX `idx_errands_status` (`status`),
  INDEX `idx_errands_customer` (`customer_id`),
  INDEX `idx_errands_rider` (`rider_id`)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Table 8: Pabili Errand Itemized Details (pabili_details_tbl)
-- ----------------------------------------------------------------------------
CREATE TABLE `pabili_details_tbl` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `errand_id` VARCHAR(36) NOT NULL,
  `item_name` VARCHAR(255) NOT NULL,
  `quantity` INT NOT NULL DEFAULT 1,
  `unit_price` DOUBLE NOT NULL DEFAULT 0,
  `estimated_subtotal` DOUBLE NOT NULL DEFAULT 0,
  `created_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`errand_id`) REFERENCES `errands` (`id`) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Table 9: Dispatch Operations Log (dispatch_logs)
-- ----------------------------------------------------------------------------
CREATE TABLE `dispatch_logs` (
  `id` INT AUTO_INCREMENT PRIMARY KEY,
  `errand_id` VARCHAR(36) NOT NULL,
  `dispatcher_id` INT NOT NULL,
  `notes` TEXT DEFAULT NULL,
  `dispatched_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  FOREIGN KEY (`errand_id`) REFERENCES `errands` (`id`) ON DELETE CASCADE,
  FOREIGN KEY (`dispatcher_id`) REFERENCES `users` (`id`) ON DELETE RESTRICT
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ----------------------------------------------------------------------------
-- Table 10: Service Rates & Fee Configuration (rate_configs)
-- ----------------------------------------------------------------------------
CREATE TABLE `rate_configs` (
  `id` INT PRIMARY KEY DEFAULT 1,
  `base_fee` DOUBLE NOT NULL DEFAULT 50,
  `per_km_rate` DOUBLE NOT NULL DEFAULT 10,
  `service_fee_percent` DOUBLE NOT NULL DEFAULT 5,
  `night_surcharge` DOUBLE NOT NULL DEFAULT 20,
  `updated_at` DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

-- ============================================================================
-- INITIAL SYSTEM SEED DATA INSERTION
-- ============================================================================

INSERT INTO `roles_tbl` (`id`, `name`, `description`) VALUES
(1, 'OWNER', 'System Business Owner'),
(2, 'DISPATCHER', 'Head Operations Dispatcher'),
(3, 'RIDER', 'Delivery Rider'),
(4, 'CUSTOMER', 'Customer User');

INSERT INTO `payment_modes` (`id`, `name`, `description`) VALUES
(1, 'Cash on Delivery (COD)', 'Pay cash upon errand fulfillment'),
(2, 'GCash Mobile Wallet', 'Direct e-wallet payment transfer'),
(3, 'Bank Transfer', 'Online banking transfer');

INSERT INTO `merchant_categories` (`id`, `name`, `description`, `merchant_count`) VALUES
(1, 'Groceries & Supermarkets', 'Food markets, fresh produce, daily essentials', 14),
(2, 'Pharmacies & Drugstores', 'Medicines, healthcare, wellness supplies', 8),
(3, 'Restaurants & Fast Food', 'Dine-in, takeout, fast food chains', 26),
(4, 'Hardware & Construction', 'Tools, building supplies, electricals', 5);

INSERT INTO `barangays` (`id`, `name`, `city`, `province`) VALUES
(1, 'Poblacion', 'Tacurong City', 'Sultan Kudarat'),
(2, 'New Isabela', 'Tacurong City', 'Sultan Kudarat'),
(3, 'San Emmanuel', 'Tacurong City', 'Sultan Kudarat'),
(4, 'EJC Montilla', 'Tacurong City', 'Sultan Kudarat'),
(5, 'Grypa', 'Tacurong City', 'Sultan Kudarat'),
(6, 'Lancheta', 'Tacurong City', 'Sultan Kudarat');

INSERT INTO `users` (`id`, `username`, `password_hash`, `role`, `first_name`, `middle_name`, `last_name`, `name`, `email`, `phone`, `avatar`, `status`) VALUES
(1, 'owner', 'owner123', 'OWNER', 'Aljayvee', 'P.', 'Versola', 'Aljayvee Versola', 'aj.versola@company.ph', '09171234567', 'AV', 'Active'),
(2, 'dispatcher', 'dispatch123', 'DISPATCHER', 'Mark Dennis', 'G.', 'Batcharo', 'Mark Dennis Batcharo', 'md.batcharo@company.ph', '09281234567', 'MB', 'Active'),
(3, 'rider01', 'rider123', 'RIDER', 'Al-Dhen', 'M.', 'Musali', 'Al-Dhen Musali', 'ad.musali@company.ph', '09391234567', 'AM', 'Active');

INSERT INTO `rate_configs` (`id`, `base_fee`, `per_km_rate`, `service_fee_percent`, `night_surcharge`) VALUES
(1, 50, 10, 5, 20);
