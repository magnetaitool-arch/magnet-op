-- (1) Salary raises are finance-only data from day one.
CREATE OR REPLACE FUNCTION public.is_finance_coll(c text)
 RETURNS boolean LANGUAGE sql IMMUTABLE AS $function$
  select c in ('invoices','payments','expenses','fixedCosts','partners',
               'partnerSettlements','profitability','employeePayments','salaryChanges');
$function$;

-- (2) Align the DB role model with the app: in the app Manager aliases to Admin (full access,
-- sees finance). Without this, a Manager moving onto JWT would silently lose finance access.
CREATE OR REPLACE FUNCTION public.is_admin()
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  select public.auth_role() in ('Owner','Admin','Manager');
$function$;

CREATE OR REPLACE FUNCTION public.is_finance()
 RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path TO 'public' AS $function$
  select public.auth_role() in ('Owner','Admin','Manager','Finance','Accountant');
$function$;;
