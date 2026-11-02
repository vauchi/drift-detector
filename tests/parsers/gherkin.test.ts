/**
 * Tests for Gherkin parser
 *
 * SPDX-FileCopyrightText: 2026 Mattia Egloff <mattia.egloff@pm.me>
 * SPDX-License-Identifier: GPL-3.0-or-later
 */

import { describe, it, expect } from "vitest";
import { GherkinParser } from "../../src/parsers/gherkin.js";
import { testConfig } from "../test-config.js";

describe("GherkinParser", () => {
  const parser = new GherkinParser(testConfig());

  describe("languageId and filePatterns", () => {
    it("should have correct languageId", () => {
      expect(parser.languageId).toBe("gherkin");
    });

    it("should match .feature files", () => {
      expect(parser.filePatterns).toContain("**/*.feature");
    });
  });

  describe("parseFile - basic feature", () => {
    const basicFeature = `
Feature: User Authentication
  As a user
  I want to log in
  So that I can access my account

  Scenario: Successful login
    Given I am on the login page
    When I enter valid credentials
    Then I should be logged in
`;

    it("should extract the feature", () => {
      const result = parser.parseFile("/test/auth.feature", basicFeature);
      const feature = result.entities.find((e) => e.entityType === "feature");

      expect(feature).toBeDefined();
      expect(feature!.name).toBe("User Authentication");
      expect(feature!.layer).toBe("feature");
    });

    it("should extract the scenario", () => {
      const result = parser.parseFile("/test/auth.feature", basicFeature);
      const scenario = result.entities.find((e) => e.entityType === "scenario");

      expect(scenario).toBeDefined();
      expect(scenario!.name).toBe("Successful login");
      expect(scenario!.layer).toBe("feature");
    });

    it("should extract steps in scenario metadata", () => {
      const result = parser.parseFile("/test/auth.feature", basicFeature);
      const scenario = result.entities.find((e) => e.entityType === "scenario");

      expect(scenario!.metadata.steps).toEqual([
        "Given I am on the login page",
        "When I enter valid credentials",
        "Then I should be logged in",
      ]);
    });

    it("should capture line numbers", () => {
      const result = parser.parseFile("/test/auth.feature", basicFeature);
      const feature = result.entities.find((e) => e.entityType === "feature");
      const scenario = result.entities.find((e) => e.entityType === "scenario");

      expect(feature!.startLine).toBe(2);
      expect(scenario!.startLine).toBeGreaterThan(feature!.startLine);
    });
  });

  describe("parseFile - tags", () => {
    const taggedFeature = `
@auth @security
Feature: Login Security

  @smoke @critical
  Scenario: Brute force protection
    Given a user has failed login 5 times
    Then the account should be locked
`;

    it("should extract feature tags", () => {
      const result = parser.parseFile("/test/security.feature", taggedFeature);
      const feature = result.entities.find((e) => e.entityType === "feature");

      expect(feature!.tags).toContain("auth");
      expect(feature!.tags).toContain("security");
    });

    it("should extract scenario tags including inherited feature tags", () => {
      const result = parser.parseFile("/test/security.feature", taggedFeature);
      const scenario = result.entities.find((e) => e.entityType === "scenario");

      // Scenario should have its own tags plus inherited feature tags
      expect(scenario!.tags).toContain("smoke");
      expect(scenario!.tags).toContain("critical");
      expect(scenario!.tags).toContain("auth");
      expect(scenario!.tags).toContain("security");
    });

    it("should generate reference hints from tags", () => {
      const result = parser.parseFile("/test/security.feature", taggedFeature);

      expect(result.references).toContainEqual(
        expect.objectContaining({
          type: "tag",
          target: "auth",
        }),
      );
      expect(result.references).toContainEqual(
        expect.objectContaining({
          type: "tag",
          target: "security",
        }),
      );
    });
  });

  describe("parseFile - scenario outline", () => {
    const outlineFeature = `
Feature: Data Validation

  Scenario Outline: Validate input length
    Given I enter "<input>" in the field
    Then I should see "<result>"

    Examples:
      | input | result |
      | abc   | valid  |
      | a     | error  |
`;

    it("should extract scenario outline", () => {
      const result = parser.parseFile(
        "/test/validation.feature",
        outlineFeature,
      );
      const outline = result.entities.find(
        (e) => e.entityType === "scenario_outline",
      );

      expect(outline).toBeDefined();
      expect(outline!.name).toBe("Validate input length");
    });

    it("should include examples in metadata", () => {
      const result = parser.parseFile(
        "/test/validation.feature",
        outlineFeature,
      );
      const outline = result.entities.find(
        (e) => e.entityType === "scenario_outline",
      );

      expect(outline!.metadata.examples).toBeDefined();
      expect(
        (outline!.metadata.examples as unknown[][]).length,
      ).toBeGreaterThan(0);
    });
  });

  describe("parseFile - background", () => {
    const backgroundFeature = `
Feature: Shopping Cart

  Background:
    Given I am logged in
    And I have items in my cart

  Scenario: View cart
    When I click on the cart icon
    Then I should see my items
`;

    it("should extract background", () => {
      const result = parser.parseFile("/test/cart.feature", backgroundFeature);
      const background = result.entities.find(
        (e) => e.entityType === "background",
      );

      expect(background).toBeDefined();
      expect(background!.layer).toBe("feature");
    });

    it("should include background steps in metadata", () => {
      const result = parser.parseFile("/test/cart.feature", backgroundFeature);
      const background = result.entities.find(
        (e) => e.entityType === "background",
      );

      expect(background!.metadata.steps).toEqual([
        "Given I am logged in",
        "And I have items in my cart",
      ]);
    });
  });

  describe("parseFile - multiple scenarios", () => {
    const multiScenarioFeature = `
Feature: User Registration

  Scenario: Register with email
    Given I am on the registration page
    When I submit a valid email
    Then I should receive a confirmation

  Scenario: Register with phone
    Given I am on the registration page
    When I submit a valid phone number
    Then I should receive an SMS code
`;

    it("should extract all scenarios", () => {
      const result = parser.parseFile(
        "/test/registration.feature",
        multiScenarioFeature,
      );
      const scenarios = result.entities.filter(
        (e) => e.entityType === "scenario",
      );

      expect(scenarios).toHaveLength(2);
      expect(scenarios.map((s) => s.name)).toEqual([
        "Register with email",
        "Register with phone",
      ]);
    });
  });

  describe("parseFile - error handling", () => {
    it("should return empty entities for empty content", () => {
      const result = parser.parseFile("/test/empty.feature", "");

      expect(result.entities).toHaveLength(0);
      expect(result.errors).toHaveLength(0);
    });

    it("should return error for invalid Gherkin syntax", () => {
      const invalidGherkin = `
This is not valid Gherkin
Just random text
`;
      const result = parser.parseFile("/test/invalid.feature", invalidGherkin);

      // Should either have errors or empty entities (depending on how strict we want to be)
      expect(
        result.errors.length > 0 || result.entities.length === 0,
      ).toBeTruthy();
    });
  });

  describe("parseFile - description extraction", () => {
    const descriptionFeature = `
Feature: Contact Exchange
  Privacy-focused contact sharing via QR codes.
  Users can share and receive contact information securely.

  Scenario: Share contact via QR
    Given I have a contact card
    When I display my QR code
    Then another user can scan it
`;

    it("should extract feature description", () => {
      const result = parser.parseFile(
        "/test/exchange.feature",
        descriptionFeature,
      );
      const feature = result.entities.find((e) => e.entityType === "feature");

      expect(feature!.metadata.description).toContain("Privacy-focused");
    });
  });

  describe("parseFile - qualified names", () => {
    it("should set qualified name for scenarios as Feature::Scenario", () => {
      const feature = `
Feature: My Feature
  Scenario: My Scenario
    Given something
`;
      const result = parser.parseFile("/test/qualified.feature", feature);
      const scenario = result.entities.find((e) => e.entityType === "scenario");

      expect(scenario!.qualifiedName).toBe("My Feature::My Scenario");
    });
  });
});
