-- DropForeignKey
ALTER TABLE `addresses` DROP FOREIGN KEY `addresses_userId_fkey`;

-- DropForeignKey
ALTER TABLE `addresses` DROP FOREIGN KEY `addresses_barangayId_fkey`;

-- DropTable
DROP TABLE `addresses`;

-- DropTable
DROP TABLE `barangays`;

-- DropTable
DROP TABLE `roles_tbl`;
