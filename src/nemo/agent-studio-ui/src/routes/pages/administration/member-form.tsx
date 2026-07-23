import { useCallback, useState, type ReactElement } from "react";

import { Button } from "@/ui-lib/base-components/button/button";
import { Card } from "@/ui-lib/base-components/card/card";
import { CardContent } from "@/ui-lib/base-components/card/card.content";
import { Input } from "@/ui-lib/base-components/input/input";
import { SelectDropdown } from "@/ui-lib/base-components/select-dropdown/select-dropdown";
import { Typography } from "@/ui-lib/base-components/typography/typography";
import {
  ADMINISTRATION_MEMBER_FORM_DEFAULTS,
  ADMINISTRATION_MEMBER_ROLE_OPTIONS,
  ADMINISTRATION_MEMBERS_STRINGS,
  type AdministrationMemberFormValues,
} from "./administration-members.consts";
import "./member-form.scss";

interface MemberFormProps {
  open: boolean;
  mode: "add" | "edit";
  initialValues?: AdministrationMemberFormValues;
  isSubmitting?: boolean;
  onSubmit: (values: AdministrationMemberFormValues) => void;
  onCancel: () => void;
}

function MemberForm({
  open,
  mode,
  initialValues = ADMINISTRATION_MEMBER_FORM_DEFAULTS,
  isSubmitting = false,
  onSubmit,
  onCancel,
}: MemberFormProps): ReactElement | null {
  const [values, setValues] = useState<AdministrationMemberFormValues>(initialValues);
  const [nameError, setNameError] = useState<string | undefined>();
  const [emailError, setEmailError] = useState<string | undefined>();

  const handleSubmit = useCallback(() => {
    const trimmedName = values.name.trim();
    const trimmedEmail = values.email.trim();
    let hasError = false;

    if (!trimmedName) {
      setNameError(ADMINISTRATION_MEMBERS_STRINGS.NAME_REQUIRED);
      hasError = true;
    } else {
      setNameError(undefined);
    }

    if (!trimmedEmail) {
      setEmailError(ADMINISTRATION_MEMBERS_STRINGS.EMAIL_REQUIRED);
      hasError = true;
    } else {
      setEmailError(undefined);
    }

    if (hasError) return;

    onSubmit({
      ...values,
      name: trimmedName,
      email: trimmedEmail,
    });
  }, [onSubmit, values]);

  if (!open) return null;

  return (
    <div className="member-form">
      <header className="member-form__header">
        <Typography Component="h2" fontSize="fs20" boldness="semibold">
          {ADMINISTRATION_MEMBERS_STRINGS.ADD_FORM_TITLE}
        </Typography>
        <Typography Component="p" fontSize="fs14" color="var(--text-secondary)">
          {mode === "edit"
            ? ADMINISTRATION_MEMBERS_STRINGS.EDIT_FORM_SUBTITLE
            : ADMINISTRATION_MEMBERS_STRINGS.ADD_FORM_SUBTITLE}
        </Typography>
      </header>

      <div className="member-form__content">
        <Card className="member-form__card">
          <CardContent className="member-form__card-content">
            <Input
              label={ADMINISTRATION_MEMBERS_STRINGS.NAME_LABEL}
              placeholder={ADMINISTRATION_MEMBERS_STRINGS.NAME_PLACEHOLDER}
              value={values.name}
              isDisabled={isSubmitting || mode === "edit"}
              isError={Boolean(nameError)}
              onChange={(event) => {
                setValues((current) => ({ ...current, name: event.target.value }));
                if (nameError) setNameError(undefined);
              }}
            />
            {nameError && (
              <Typography Component="p" fontSize="fs14" color="var(--notification-error)">
                {nameError}
              </Typography>
            )}

            <Input
              type="email"
              label={ADMINISTRATION_MEMBERS_STRINGS.EMAIL_LABEL}
              placeholder={ADMINISTRATION_MEMBERS_STRINGS.EMAIL_PLACEHOLDER}
              value={values.email}
              isDisabled={isSubmitting || mode === "edit"}
              isError={Boolean(emailError)}
              onChange={(event) => {
                setValues((current) => ({ ...current, email: event.target.value }));
                if (emailError) setEmailError(undefined);
              }}
            />
            {emailError && (
              <Typography Component="p" fontSize="fs14" color="var(--notification-error)">
                {emailError}
              </Typography>
            )}
          </CardContent>
        </Card>

        <Typography
          Component="h3"
          fontSize="fs14"
          boldness="semibold"
          className="member-form__role-heading"
        >
          {ADMINISTRATION_MEMBERS_STRINGS.ROLE_SECTION_TITLE}
        </Typography>

        <Card className="member-form__card">
          <CardContent className="member-form__card-content">
            <SelectDropdown
              label={ADMINISTRATION_MEMBERS_STRINGS.ROLE_LABEL}
              size="fill"
              items={[...ADMINISTRATION_MEMBER_ROLE_OPTIONS]}
              value={values.role}
              onValueChange={(value) => {
                setValues((current) => ({
                  ...current,
                  role: String(value) as AdministrationMemberFormValues["role"],
                }));
              }}
              options={{ isClearable: false }}
              disabled={isSubmitting}
            />
          </CardContent>
        </Card>
      </div>

      <div className="member-form__actions">
        <Button
          variant="solid"
          size="large"
          label={mode === "add" ? ADMINISTRATION_MEMBERS_STRINGS.ADD_LABEL : ADMINISTRATION_MEMBERS_STRINGS.SAVE_LABEL}
          isDisabled={isSubmitting}
          onClick={handleSubmit}
        />
        <Button
          variant="outline"
          size="large"
          label={ADMINISTRATION_MEMBERS_STRINGS.CANCEL_LABEL}
          isDisabled={isSubmitting}
          onClick={onCancel}
        />
      </div>
    </div>
  );
}

export { MemberForm };
export type { MemberFormProps };
