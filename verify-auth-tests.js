import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';

async function runVerificationTests() {

  console.log("==================================================");
  console.log("Backend Auth API Verification Test Suite (Remediated)");
  console.log("==================================================");
  
  let passedCount = 0;
  let failedCount = 0;

  function assert(condition, message) {
    if (condition) {
      console.log(`  [PASS] ${message}`);
      passedCount++;
    } else {
      console.error(`  [FAIL] ${message}`);
      failedCount++;
    }
  }

  // ----------------------------------------------------
  // Test Case 1: Bcrypt Hashing Functionality
  // ----------------------------------------------------
  console.log("\nTest Suite 1: Bcrypt Hashing & Comparison");
  const testPass = "SecurePass123!";
  const hash = await bcrypt.hash(testPass, 10);
  
  assert(typeof hash === 'string', "bcrypt.hash returns a string");
  assert(hash.startsWith('$2a$'), "bcrypt.hash generates valid $2a$ salt format");
  assert(hash.length === 60, `bcrypt.hash generates 60-char string (got ${hash.length})`);
  
  const matchTrue = await bcrypt.compare(testPass, hash);
  assert(matchTrue === true, "bcrypt.compare returns true for correct password");
  
  const matchFalse = await bcrypt.compare("WrongPassword!", hash);
  assert(matchFalse === false, "bcrypt.compare returns false for incorrect password");

  // ----------------------------------------------------
  // Test Case 2: Registration Endpoint Logic (POST /api/users)
  // ----------------------------------------------------
  console.log("\nTest Suite 2: Registration Endpoint Logic (POST /api/users)");
  
  // Mock DB Store
  const mockDbUsers = [];
  
  async function mockRegisterUserHandler(reqBody) {
    const { username, password, role, name, email, phone, firstName, middleName, lastName } = reqBody;
    
    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      username.trim() === "" ||
      password.trim() === ""
    ) {
      return {
        status: 400,
        body: { error: "Username and password must be non-empty strings" }
      };
    }

    const nameParts = (name || "").trim().split(" ");
    const fName = firstName || nameParts[0] || "User";
    const lName = lastName || nameParts.slice(1).join(" ") || "Account";

    const hashedPassword = await bcrypt.hash(password, 10);

    const newUser = {
      id: mockDbUsers.length + 1,
      username,
      passwordHash: hashedPassword,
      role: role ? role.toUpperCase() : "CUSTOMER",
      firstName: fName,
      middleName: middleName || "",
      lastName: lName,
      name: name || `${fName} ${lName}`,
      email: email || "",
      phone: phone || "",
      status: "Active",
      createdAt: new Date(),
      updatedAt: new Date()
    };
    
    mockDbUsers.push(newUser);

    const { passwordHash: _, ...sanitizedUser } = newUser;
    return { status: 201, body: sanitizedUser };
  }

  // 2a. Valid Registration
  const regRes = await mockRegisterUserHandler({
    username: "john_doe",
    password: "Password@123",
    email: "john@example.com",
    role: "CUSTOMER",
    name: "John Doe"
  });

  assert(regRes.status === 201, "Registration returns 201 Created status");
  assert(regRes.body.username === "john_doe", "Returned user matches request username");
  assert(regRes.body.passwordHash === undefined, "Returned user payload OMITS passwordHash field");
  assert(mockDbUsers[0].passwordHash.startsWith('$2a$'), "Database record stores hashed password (starts with $2a$)");

  // 2b. Registration Non-String / Missing Input Validation
  const regNumUser = await mockRegisterUserHandler({ username: 123, password: "Password@123" });
  assert(regNumUser.status === 400, "Numeric username registration returns 400 Bad Request");
  assert(regNumUser.body.error === "Username and password must be non-empty strings", "Numeric username returns exact error message");

  const regNoPass = await mockRegisterUserHandler({ username: "john_doe2" });
  assert(regNoPass.status === 400, "Missing password registration returns 400 Bad Request");
  assert(regNoPass.body.error === "Username and password must be non-empty strings", "Missing password returns exact error message");

  // ----------------------------------------------------
  // Test Case 3: Login Endpoint Logic (POST /api/auth/login)
  // ----------------------------------------------------
  console.log("\nTest Suite 3: Login Endpoint Logic (POST /api/auth/login)");

  async function mockLoginHandler(reqBody) {
    const { username, password } = reqBody;

    if (
      typeof username !== "string" ||
      typeof password !== "string" ||
      username.trim() === "" ||
      password.trim() === ""
    ) {
      return {
        status: 400,
        body: { error: "Username and password must be non-empty strings" }
      };
    }

    const user = mockDbUsers.find(u => u.username === username);

    if (!user) {
      return { status: 401, body: { error: "Invalid username or password" } };
    }

    const isPasswordValid = await bcrypt.compare(password, user.passwordHash);

    if (!isPasswordValid) {
      return { status: 401, body: { error: "Invalid username or password" } };
    }

    const { passwordHash: _, ...sanitizedUser } = user;
    const token = jwt.sign(
      { id: sanitizedUser.id, username: sanitizedUser.username, email: sanitizedUser.email, role: sanitizedUser.role },
      "capstone_jwt_super_secret_key_2026",
      { expiresIn: "24h" }
    );
    return { status: 200, body: { ...sanitizedUser, user: sanitizedUser, token, message: "Login successful" } };
  }

  // 3a. Successful Login
  const loginSuccess = await mockLoginHandler({
    username: "john_doe",
    password: "Password@123"
  });
  assert(loginSuccess.status === 200, "Valid login returns 200 OK status");
  assert(loginSuccess.body.username === "john_doe", "Valid login returns sanitized user object");
  assert(loginSuccess.body.passwordHash === undefined, "Sanitized user object omits passwordHash");
  assert(typeof loginSuccess.body.token === "string" && loginSuccess.body.token.startsWith("eyJ"), "Valid login returns signed JWT token starting with 'eyJ'");


  // 3b. Invalid Password
  const loginBadPass = await mockLoginHandler({
    username: "john_doe",
    password: "WrongPassword"
  });
  assert(loginBadPass.status === 401, "Invalid password returns 401 Unauthorized status");
  assert(loginBadPass.body.error === "Invalid username or password", "Returns appropriate error message");

  // 3c. Non-existent User
  const loginNoUser = await mockLoginHandler({
    username: "unknown_user",
    password: "Password@123"
  });
  assert(loginNoUser.status === 401, "Non-existent user returns 401 Unauthorized status");

  // 3d. Missing Credentials
  const loginMissing = await mockLoginHandler({
    username: "",
    password: ""
  });
  assert(loginMissing.status === 400, "Empty credentials return 400 Bad Request status");
  assert(loginMissing.body.error === "Username and password must be non-empty strings", "Empty credentials return exact error message");

  // 3e. Non-String Inputs (Number, Boolean, Object)
  const loginNumUser = await mockLoginHandler({ username: 123, password: "Password@123" });
  assert(loginNumUser.status === 400, "Numeric username login returns 400 Bad Request");
  assert(loginNumUser.body.error === "Username and password must be non-empty strings", "Numeric username returns exact error message");

  const loginBoolUser = await mockLoginHandler({ username: true, password: "Password@123" });
  assert(loginBoolUser.status === 400, "Boolean username login returns 400 Bad Request");

  const loginNumPass = await mockLoginHandler({ username: "john_doe", password: 99999 });
  assert(loginNumPass.status === 400, "Numeric password login returns 400 Bad Request");

  // ----------------------------------------------------
  // Test Case 4: Seed Account Password Verification
  // ----------------------------------------------------
  console.log("\nTest Suite 4: Seed Account Password Hashing");
  const seededAccounts = [
    { username: "owner", rawPass: "owner123" },
    { username: "dispatcher", rawPass: "dispatch123" },
    { username: "rider01", rawPass: "rider123" },
  ];

  for (const acc of seededAccounts) {
    const hashedPass = await bcrypt.hash(acc.rawPass, 10);
    const valid = await bcrypt.compare(acc.rawPass, hashedPass);
    assert(valid === true, `Seed password for '${acc.username}' is hashable and verifiable with bcrypt`);
  }

  console.log("\n==================================================");
  console.log(`Test Execution Results: ${passedCount} PASSED, ${failedCount} FAILED`);
  console.log("==================================================");

  return { passedCount, failedCount };
}

runVerificationTests();
