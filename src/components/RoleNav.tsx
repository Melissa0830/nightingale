import styles from "./RoleNav.module.css";

// Block 1 scope: /patients does not exist until Block 2, so the item is
// shown but not a link — avoids a dead link while still communicating the
// intended next workspace. No other nav items: Analytics/Reports/
// Appointments/etc. are explicitly out of scope for this product.
export default function RoleNav() {
  return (
    <nav className={styles.nav} aria-label="Primary">
      <button type="button" className={styles.item} disabled title="Available in the next block">
        Patients
        <span className={styles.badge}>Soon</span>
      </button>
    </nav>
  );
}
