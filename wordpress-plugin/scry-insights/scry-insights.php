<?php
/**
 * Plugin Name:       Scry Insights
 * Description:       Shows Search Console clicks, impressions and position from your Scry deployment in the posts list and post editor.
 * Version:           0.1.0
 * Requires at least: 6.4
 * Requires PHP:      8.0
 * Author:            Gaurav Tiwari
 * License:           MIT
 * License URI:       https://opensource.org/licenses/MIT
 * Text Domain:       scry-insights
 */

defined( 'ABSPATH' ) || exit;

final class Scry_Insights {

	const OPTION   = 'scry_insights';
	const CACHE    = 'scry_insights_pages';
	const CAP      = 'edit_posts';

	public static function init(): void {
		add_action( 'admin_menu', array( __CLASS__, 'menu' ) );
		add_action( 'admin_init', array( __CLASS__, 'register_settings' ) );
		add_action( 'add_meta_boxes', array( __CLASS__, 'meta_box' ) );
		foreach ( array( 'post', 'page' ) as $type ) {
			add_filter( "manage_{$type}_posts_columns", array( __CLASS__, 'column' ) );
			add_action( "manage_{$type}_posts_custom_column", array( __CLASS__, 'column_value' ), 10, 2 );
		}
	}

	private static function settings(): array {
		$s = get_option( self::OPTION, array() );
		return wp_parse_args( is_array( $s ) ? $s : array(), array( 'endpoint' => '', 'api_key' => '', 'property' => '' ) );
	}

	private static function configured(): bool {
		$s = self::settings();
		return '' !== $s['endpoint'] && '' !== $s['api_key'] && '' !== $s['property'];
	}

	/** GET /api/p/{property}/{path}. Returns decoded JSON or WP_Error. */
	private static function request( string $path, array $args = array() ) {
		$s   = self::settings();
		$url = trailingslashit( $s['endpoint'] ) . 'api/p/' . rawurlencode( $s['property'] ) . '/' . ltrim( $path, '/' );
		$url = add_query_arg( array_map( 'rawurlencode', $args ), $url );
		$res = wp_remote_get(
			$url,
			array(
				'timeout' => 15,
				'headers' => array( 'Authorization' => 'Bearer ' . $s['api_key'] ),
			)
		);
		if ( is_wp_error( $res ) ) {
			return $res;
		}
		$code = wp_remote_retrieve_response_code( $res );
		$body = json_decode( wp_remote_retrieve_body( $res ), true );
		if ( 200 !== $code ) {
			return new WP_Error( 'scry_insights', is_array( $body ) && isset( $body['error'] ) ? (string) $body['error'] : "HTTP $code" );
		}
		return $body;
	}

	// ---------- settings ----------

	public static function menu(): void {
		add_options_page( 'Scry Insights', 'Scry Insights', 'manage_options', 'scry-insights', array( __CLASS__, 'settings_page' ) );
	}

	public static function register_settings(): void {
		register_setting(
			'scry_insights',
			self::OPTION,
			array(
				'type'              => 'array',
				'sanitize_callback' => function ( $v ) {
					delete_transient( self::CACHE );
					$old = self::settings();
					$key = isset( $v['api_key'] ) ? trim( (string) $v['api_key'] ) : '';
					return array(
						'endpoint' => esc_url_raw( trim( (string) ( $v['endpoint'] ?? '' ) ) ),
						// Blank field keeps the saved key so it never has to be printed back.
						'api_key'  => '' === $key ? $old['api_key'] : sanitize_text_field( $key ),
						'property' => sanitize_text_field( (string) ( $v['property'] ?? '' ) ),
					);
				},
			)
		);
	}

	public static function settings_page(): void {
		if ( ! current_user_can( 'manage_options' ) ) {
			return;
		}
		$s = self::settings();
		?>
		<div class="wrap">
			<h1>Scry Insights</h1>
			<p>Connect this site to your Scry deployment. Create a <strong>read</strong> API key in the dashboard under Settings → API keys.</p>
			<form method="post" action="options.php">
				<?php settings_fields( 'scry_insights' ); ?>
				<table class="form-table" role="presentation">
					<tr><th scope="row"><label for="si-endpoint">Dashboard URL</label></th>
						<td><input id="si-endpoint" class="regular-text" type="url" name="<?php echo esc_attr( self::OPTION ); ?>[endpoint]" value="<?php echo esc_attr( $s['endpoint'] ); ?>" placeholder="https://scry.example.com"></td></tr>
					<tr><th scope="row"><label for="si-key">API key</label></th>
						<td><input id="si-key" class="regular-text" type="password" autocomplete="off" name="<?php echo esc_attr( self::OPTION ); ?>[api_key]" value="" placeholder="<?php echo $s['api_key'] ? esc_attr__( 'Saved. Leave blank to keep it.', 'scry-insights' ) : 'gsk_...'; ?>"></td></tr>
					<tr><th scope="row"><label for="si-prop">Property</label></th>
						<td><input id="si-prop" class="regular-text" type="text" name="<?php echo esc_attr( self::OPTION ); ?>[property]" value="<?php echo esc_attr( $s['property'] ); ?>" placeholder="example.com">
						<p class="description">Property id or domain, as listed in the dashboard.</p></td></tr>
				</table>
				<?php submit_button(); ?>
			</form>
		</div>
		<?php
	}

	// ---------- posts list column ----------

	/** One request for the top 5,000 pages, cached for 6 hours. */
	private static function page_map(): array {
		$map = get_transient( self::CACHE );
		if ( is_array( $map ) ) {
			return $map;
		}
		$map  = array();
		$data = self::request( 'pages', array( 'days' => '28', 'limit' => '5000', 'compare' => 'previous' ) );
		if ( ! is_wp_error( $data ) && ! empty( $data['rows'] ) ) {
			foreach ( $data['rows'] as $row ) {
				$map[ self::norm( $row['page'] ) ] = array( $row['clicks'], $row['impressions'], $row['position'], $row['delta_clicks'] ?? null );
			}
		}
		set_transient( self::CACHE, $map, 6 * HOUR_IN_SECONDS );
		return $map;
	}

	private static function norm( string $url ): string {
		return untrailingslashit( preg_replace( '#^https?://(www\.)?#', '', strtolower( $url ) ) );
	}

	public static function column( array $cols ): array {
		if ( self::configured() && current_user_can( self::CAP ) ) {
			$cols['scry_insights'] = 'Search (28d)';
		}
		return $cols;
	}

	public static function column_value( string $col, int $post_id ): void {
		if ( 'scry_insights' !== $col || 'publish' !== get_post_status( $post_id ) ) {
			return;
		}
		$map = self::page_map();
		$row = $map[ self::norm( (string) get_permalink( $post_id ) ) ] ?? null;
		if ( ! $row ) {
			echo '<span aria-hidden="true">–</span>';
			return;
		}
		[ $clicks, $impr, $pos, $delta ] = $row;
		printf(
			'%s clicks%s<br><span style="color:#50575e">%s impr. · pos %s</span>',
			esc_html( number_format_i18n( $clicks ) ),
			null === $delta ? '' : esc_html( sprintf( ' (%s%s)', $delta > 0 ? '+' : '', number_format_i18n( $delta ) ) ),
			esc_html( number_format_i18n( $impr ) ),
			esc_html( (string) $pos )
		);
	}

	// ---------- editor meta box ----------

	public static function meta_box(): void {
		if ( ! self::configured() ) {
			return;
		}
		add_meta_box( 'scry-insights', 'Search Console (28 days)', array( __CLASS__, 'render_box' ), array( 'post', 'page' ), 'side', 'default' );
	}

	public static function render_box( WP_Post $post ): void {
		if ( 'publish' !== $post->post_status ) {
			echo '<p>Publish the post to see search data.</p>';
			return;
		}
		$url  = (string) get_permalink( $post );
		$key  = 'scry_insights_page_' . md5( $url );
		$data = get_transient( $key );
		if ( false === $data ) {
			$data = self::request( 'page', array( 'url' => $url, 'days' => '28' ) );
			if ( ! is_wp_error( $data ) ) {
				set_transient( $key, $data, HOUR_IN_SECONDS );
			}
		}
		if ( is_wp_error( $data ) ) {
			echo '<p>' . esc_html( $data->get_error_message() ) . '</p>';
			return;
		}
		$c = $data['summary']['current'];
		$d = $data['summary']['delta'] ?? array();
		echo '<table class="widefat striped" style="border:0"><tbody>';
		foreach ( array(
			'Clicks'      => number_format_i18n( $c['clicks'] ) . ( isset( $d['clicks'] ) ? sprintf( ' (%s%s)', $d['clicks'] > 0 ? '+' : '', number_format_i18n( $d['clicks'] ) ) : '' ),
			'Impressions' => number_format_i18n( $c['impressions'] ),
			'CTR'         => null === $c['ctr'] ? '–' : $c['ctr'] . '%',
			'Position'    => $c['position'] ?? '–',
			'Index'       => $data['inspection']['coverage_state'] ?? 'Not inspected',
		) as $label => $value ) {
			printf( '<tr><th scope="row" style="padding:4px 8px">%s</th><td style="padding:4px 8px">%s</td></tr>', esc_html( $label ), esc_html( (string) $value ) );
		}
		echo '</tbody></table>';
		if ( ! empty( $data['queries'] ) ) {
			echo '<p style="margin:10px 0 4px"><strong>Top queries</strong></p><ol style="margin:0 0 0 18px">';
			foreach ( array_slice( $data['queries'], 0, 8 ) as $q ) {
				printf( '<li>%s <span style="color:#50575e">(%s clicks, pos %s)</span></li>', esc_html( $q['query'] ), esc_html( number_format_i18n( $q['clicks'] ) ), esc_html( (string) $q['position'] ) );
			}
			echo '</ol>';
		}
		$s = self::settings();
		printf(
			'<p style="margin-top:10px"><a href="%s" target="_blank" rel="noopener">Open full report</a></p>',
			esc_url( trailingslashit( $s['endpoint'] ) . '#/p/' . rawurlencode( $s['property'] ) . '/page?url=' . rawurlencode( $url ) )
		);
	}
}

Scry_Insights::init();
